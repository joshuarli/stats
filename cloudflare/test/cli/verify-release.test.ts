import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const policy = { schema: "stats-release-policy/2", id: "test", profile: { name: "smoke", definitionSha256: "a".repeat(64) }, baselineRelease: "old", candidateRelease: "new", workloadId: "load", workloadSha256: createHash("sha256").update(workloadText).digest("hex"), requiredSources: [{ source: "app", producer: "one", families: ["requests"] }], windows: { startMs: 1000, warmupMs: 0, measureMs: 100 }, minimums: { measureMs: 100, requests: 100 }, maxEvidenceAgeMs: 500, absolute: { maxErrorShare: 0.01, p95Ms: 20, p99Ms: 20, maxLostWrites: 0, maxHistoryMismatches: 0, maxCpuSecondsPerKRequests: 1000, maxMemoryPeakBytes: 1000, maxRestarts: 0 }, regression: { latency: { maxRelativeIncreasePercent: 10, absoluteFloorMs: 2 }, maxCpuRelativeIncreasePercent: 20, maxMemoryRelativeIncreasePercent: 20 }, histogramMaxRelativeError: 0.05, recovery: { required: true, method: "rollback" } };
  const cohort = (releaseId: string) => ({ releaseId, workloadId: "load", attempted: 100, succeeded: 100, failures: {}, bodyMismatches: 0, acknowledgedWrites: 10, readbackVerified: 10, lostWrites: 0, duplicateMismatches: 0, history: { samples: [{ host: "h_1", boot: "boot", sample: { seq: "1", atMs: "1", monoMs: "1", cpuCount: 1, uptimeMs: "1", cpu: { user: "1", system: "1", idle: "1", total: "3" } } }], phases: [{ phase: "before", expected: 1, verified: 1, missing: 0, mismatched: 0 }, { phase: "after", expected: 1, verified: 1, missing: 0, mismatched: 0 }] }, histogram: { relativeError: 0.01, buckets: [[10000, 100]] }, windowStartMs: 1000, windowEndMs: 1100, truncated: false });
  const observation = (releaseId: string) => ({ observer: { status: "ok", checkedAtMs: 1150 }, sources: [{ source: "app", producer: "one", releaseId, lastSeenMs: 1150, sequenceStart: { startedAtMs: 900, atMs: 1000, accepted: 0, dropped: 0, queued: 0 }, sequenceEnd: { startedAtMs: 900, atMs: 1100, accepted: 100, dropped: 0, queued: 0 }, received: 100, families: { requests: { okSamples: 2, usable: true, reason: null as string | null } } }], truncated: false, hostConfounded: false, resources: { cpuSeconds: 10, memoryPeakBytes: 100, restarts: 0 } });
  const files = { "policy.json": policy, "baseline.manifest.json": { releaseId: "old", artifactDigest: `sha256:${"b".repeat(64)}`, components: { app: `sha256:${"b".repeat(64)}` } }, "candidate.manifest.json": { releaseId: "new", artifactDigest: `sha256:${"c".repeat(64)}`, components: { app: `sha256:${"c".repeat(64)}` } }, "workload.json": workload, "ledger.json": { schema: "stats-release-evidence/1", baseline: cohort("old"), candidate: cohort("new") }, "observations.json": { schema: "stats-release-evidence/1", baseline: observation("old"), candidate: observation("new") }, "recovery.json": { method: "rollback", verifiedAtMs: 1150, previousRelease: "old", readbackVerified: true } };
  const write = () => { for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value)); };
  const decide = (at = now) => { write(); return decideRelease(readReleaseEvidence(dir, false), at); };
  return { dir, files, write, decide };
}

await test("release eligibility requires complete and correct evidence", () => {
  assert.equal(bundle().decide().verdict, "pass");
  const cases: [string, (b: ReturnType<typeof bundle>) => void, string, string][] = [
    ["missing source", b => { b.files["observations.json"].candidate.sources = []; }, "inconclusive", "source-missing"],
    ["producer absent", b => { b.files["policy.json"].requiredSources.push({ source: "app", producer: "two", families: ["requests"] }); }, "inconclusive", "source-missing"],
    ["mixed release", b => { b.files["observations.json"].candidate.sources[0]!.releaseId = "old"; }, "reject", "mixed-release"],
    ["baseline history mismatch", b => { const phase = b.files["ledger.json"].baseline.history.phases[0]!; phase.verified = 0; phase.mismatched = 1; }, "reject", "history-mismatch"],
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
  const b = bundle(); b.files["ledger.json"].candidate.histogram.buckets = [[11000, 100]]; b.files["policy.json"].absolute.p99Ms = 11; assert.equal(b.decide().verdict, "pass");
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
  const missing = await runCli(["verify", "release", "--evidence", join(b.dir, "missing"), "--json"], {});
  assert.equal(missing.code, 2);
  const args = ["verify", "release", "--evidence", b.dir, "--replay", "--json"];
  const pass = await runCli(args, {}); assert.equal(pass.code, 0, pass.stderr); assert.equal((JSON.parse(pass.stdout) as { payload: { verdict: string } }).payload.verdict, "pass");
  writeFileSync(join(b.dir, "decision.json"), JSON.stringify({ evaluatedAtMs: now, verdict: "reject", reasonCodes: [] }));
  const mismatch = await runCli(args, {}); assert.equal(mismatch.code, 4); assert.equal((JSON.parse(mismatch.stdout) as { error: { code: string } }).error.code, "contract");
});

await test("candidate absolute limits reject even with an insufficient baseline", () => {
  const b = bundle();
  b.files["ledger.json"].baseline.attempted = 0;
  b.files["ledger.json"].baseline.succeeded = 0;
  b.files["ledger.json"].baseline.histogram.buckets = [];
  b.files["ledger.json"].candidate.histogram.buckets = [[30000, 100]];
  const result = b.decide();
  assert.equal(result.verdict, "reject");
  assert.ok(result.reasons.some(reason => reason.code === "latency-p99"));
});

await test("insufficient windows and required metric families hold the verdict", () => {
  const duration = bundle();
  duration.files["policy.json"].minimums.measureMs = 101;
  assert.equal(duration.decide().verdict, "inconclusive");
  const requests = bundle();
  requests.files["policy.json"].minimums.requests = 101;
  assert.equal(requests.decide().verdict, "inconclusive");
  const family = bundle();
  family.files["observations.json"].candidate.sources[0]!.families.requests = { okSamples: 0, usable: false, reason: "family-missing" };
  const result = family.decide();
  assert.equal(result.verdict, "inconclusive");
  assert.ok(result.reasons.some(reason => reason.code === "family-missing"));
  const absent = bundle();
  delete (absent.files["observations.json"].candidate.sources[0] as { families?: unknown }).families;
  assert.equal(absent.decide().verdict, "inconclusive");
  for (const reason of ["collector-restart", "stale", "window-open"]) {
    const broken = bundle();
    broken.files["observations.json"].candidate.sources[0]!.families.requests = { okSamples: 1, usable: false, reason };
    const decision = broken.decide();
    assert.equal(decision.verdict, "inconclusive");
    assert.ok(decision.reasons.some(item => item.code === reason));
  }
});

await test("built evaluator emits an immutable receipt whose evidence replays", async () => {
  const build = spawnSync("make", ["build-statsctl"], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const b = bundle();
  const decision = b.decide();
  writeFileSync(join(b.dir, "decision.json"), JSON.stringify({ evaluatedAtMs: now, verdict: decision.verdict, reasonCodes: decision.reasons.map(reason => reason.code) }));
  const receipt = `${b.dir}-receipt.json`;
  const executable = resolve(import.meta.dirname, "../../../dist/statsctl.mjs");
  const args = [executable, "verify", "release", "--evidence", b.dir, "--now", String(now), "--receipt-out", receipt, "--json"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = JSON.parse(readFileSync(receipt, "utf8")) as { schema: string; evaluator: { name: string }; inputs: { path: string; sha256: string; bytes: number }[] };
  assert.equal(record.schema, "stats-qualification-receipt/1");
  assert.equal(record.evaluator.name, "statsctl verify release");
  assert.equal(record.inputs.length, 8);
  assert.deepEqual(record.inputs.map(input => input.path), record.inputs.map(input => input.path).sort());
  for (const input of record.inputs) {
    const bytes = readFileSync(join(b.dir, input.path));
    assert.equal(input.bytes, bytes.length);
    assert.equal(input.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal((JSON.parse(readFileSync(receipt, "utf8")) as { decision: { evaluatedAtMs: number } }).decision.evaluatedAtMs, now);
  const replay = spawnSync(process.execPath, [executable, "verify", "release", "--evidence", b.dir, "--replay", "--json"], { encoding: "utf8" });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  const alias = `${b.dir}-alias`;
  symlinkSync(b.dir, alias);
  const inside = spawnSync(process.execPath, [executable, "verify", "release", "--evidence", b.dir, "--now", String(now), "--receipt-out", join(alias, "receipt.json"), "--json"], { encoding: "utf8" });
  assert.equal(inside.status, 2);
  rmSync(alias);
  const duplicate = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(duplicate.status, 2);
  writeFileSync(join(b.dir, "decision.json"), JSON.stringify({ evaluatedAtMs: 1050, verdict: "pass", reasonCodes: [] }));
  const forged = spawnSync(process.execPath, [executable, "verify", "release", "--evidence", b.dir, "--now", String(now), "--receipt-out", `${receipt}-forged`, "--json"], { encoding: "utf8" });
  assert.equal(forged.status, 2);
  writeFileSync(join(b.dir, "decision.json"), JSON.stringify({ evaluatedAtMs: now, verdict: decision.verdict, reasonCodes: decision.reasons.map(reason => reason.code) }));
  writeFileSync(join(b.dir, "unexpected"), "x");
  const extra = spawnSync(process.execPath, [executable, "verify", "release", "--evidence", b.dir, "--replay", "--json"], { encoding: "utf8" });
  assert.equal(extra.status, 2);
  rmSync(join(b.dir, "unexpected"));
  writeFileSync(join(b.dir, "__proto__"), "x");
  const prototype = spawnSync(process.execPath, [executable, "verify", "release", "--evidence", b.dir, "--replay", "--json"], { encoding: "utf8" });
  assert.equal(prototype.status, 2);
  rmSync(join(b.dir, "__proto__"));
  const unbuilt = await runCli(["verify", "release", "--evidence", b.dir, "--now", String(now), "--receipt-out", `${receipt}-unbuilt`, "--json"], {});
  assert.equal(unbuilt.code, 2);
});

await test("promotion-sized history ledgers remain readable", () => {
  const b = bundle();
  for (const side of ["baseline", "candidate"] as const) {
    const history = b.files["ledger.json"][side].history;
    const original = history.samples[0]!;
    history.samples = Array.from({ length: 1200 }, (_, index) => ({ ...original, host: `h_${"1".repeat(32)}`, boot: "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", sample: { ...original.sample, atMs: String(1795200000000 + index), monoMs: String(900000000 + index) } }));
    history.phases = history.phases.map(phase => ({ ...phase, expected: 1200, verified: 1200 }));
  }
  b.write();
  const ledger = JSON.stringify(b.files["ledger.json"], null, 2);
  assert.ok(ledger.length > 1024 * 1024);
  writeFileSync(join(b.dir, "ledger.json"), ledger);
  assert.equal(decideRelease(readReleaseEvidence(b.dir, false), now).verdict, "pass");
});
