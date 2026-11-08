import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { comparisonBounds, DEPLOYMENT_BUCKET_MS, type MetricRow } from "../../src/deployments/compare.ts";
import type { Deployment } from "../../src/deployments/model.ts";
import { compareServiceDeployment, SERVICE_COMPARISON_CAVEAT, type MinuteRollup, type ProbeSource } from "../../src/deployments/service-compare.ts";
import type { ExternalEvent, ExternalEventRecord } from "../../src/observe/ingest/model.ts";
import { parseServicePolicyText } from "../../src/cli/verify/policy.ts";
import { decodeServiceComparison } from "../../src/deployments/service-decode.ts";
import { fakeOrigin, runCli, sendJson, tokenEnv } from "./support.ts";

const SCRATCH_ROOT = resolve(import.meta.dirname, "../../../.work/tmp");
mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH_ROOT, "verify-service-"));

const HOUR = 3_600_000;
const HOST = `h_${"c".repeat(32)}`;
const AT = Date.UTC(2026, 10, 2, 12, 2, 0);
const marker = (n: number, atMs: number, version: string): Deployment => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, atMs, source: "marker", message: null, versions: [{ id: version, percentage: 100 }], deferred: false });
const PREVIOUS = marker(1, AT - 2 * HOUR, "1.0.0");
const CANDIDATE = marker(2, AT, "1.1.0");

function probeRows(window: { fromMs: number; toMs: number }, ms: number, up: number): MetricRow[] {
  const rows: MetricRow[] = [];
  for (let bucket = window.fromMs; bucket < window.toMs; bucket += DEPLOYMENT_BUCKET_MS) rows.push({ metric: "probe.health.ms", bucket_ms: bucket, value: ms }, { metric: "probe.health.up", bucket_ms: bucket, value: up });
  return rows;
}

function comparisonFor(deployment: Deployment, now: number, beforeMs: number, afterMs: number, probeSource: ProbeSource = "probed", applicationEvents: readonly ExternalEventRecord[] = [], hostRollups: (hostId: string) => readonly MinuteRollup[] = () => []) {
  const { before, after } = comparisonBounds(deployment.atMs, "1h");
  const rows = probeSource === "probed" ? [...probeRows(before, beforeMs, 1), ...probeRows(after, afterMs, 1)] : [];
  return compareServiceDeployment({ service: "web", deployment, deployments: [PREVIOUS, CANDIDATE], hostIds: [HOST], hostRollups, probeRows: rows, probeSource, window: "1h", now, truncated: false, applicationEvents });
}

function applicationEvent(eventId: string, atMs: number, operation: string, durationMs: number, work: Readonly<Record<string, number>>, outcome = "ok"): ExternalEventRecord {
  const event: ExternalEvent = {
    schemaVersion: 1, eventId, atMs, operation, outcome, durationMs, work,
    release: "1.1.0", service: "web"
  };
  return { eventId, service: "web", receivedAtMs: atMs, provenance: "application", event };
}

function workEvents(window: { readonly fromMs: number; readonly toMs: number }, operation: string, durationMs: number, work: Readonly<Record<string, number>>, prefix: string): ExternalEventRecord[] {
  const events: ExternalEventRecord[] = [];
  for (let atMs = window.fromMs + 60_000; atMs < window.toMs; atMs += 60_000) {
    events.push(applicationEvent(`${prefix}-${atMs}`, atMs, operation, durationMs, work));
  }
  return events;
}

function policyFile(name: string, over: Record<string, unknown> = {}): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({ schema: "statsctl-policy/1", id: "probe-latency", hypothesis: "The new build answers the health URL faster than the old one.", service: "web", metric: "probe.health.ms", direction: "decrease", minChangePercent: 10, floor: 10, window: "1h", ...over }));
  return path;
}

interface Document {
  readonly payload?: { readonly verdict: string; readonly caveat: string; readonly sources: { source: string; status: string }[]; readonly reasons: { code: string; message: string }[]; readonly target: { before: number | null; after: number | null } };
  readonly error?: { readonly code: string };
  readonly warnings?: { code: string }[];
}

async function verify(body: unknown, args: string[], policy = policyFile("policy.json"), deploymentId = CANDIDATE.id) {
  const origin = await fakeOrigin((_request, response) => sendJson(response, body));
  try {
    const run = await runCli(["verify", "--service", "web", "--deployment", deploymentId, "--policy", policy, "--origin", origin.origin, "--json", ...args], tokenEnv());
    return { run, document: JSON.parse(run.stdout) as Document, urls: origin.seen.map(seen => seen.url) };
  } finally {
    await origin.close();
  }
}

await test("a service policy is strict, limited to level metrics, and has no project or guardrails", () => {
  const text = (over: Record<string, unknown>) => JSON.stringify({ schema: "statsctl-policy/1", id: "p", hypothesis: "Lower CPU after the change.", service: "web", metric: "host.cpu", direction: "decrease", minChangePercent: 10, floor: 2, window: "1h", ...over });
  assert.equal(parseServicePolicyText(text({})).metric, "host.cpu");
  assert.throws(() => parseServicePolicyText(text({ metric: "worker.cpu" })), /metric must be one of/u);
  assert.throws(() => parseServicePolicyText(text({ floor: 1 })), /at least its default 2/u);
  assert.throws(() => parseServicePolicyText(text({ project: "stats" })), /unknown field project/u);
  assert.throws(() => parseServicePolicyText(text({ guardrails: [] })), /unknown field guardrails/u);
  assert.throws(() => parseServicePolicyText(text({ minChangePercent: 5 })), /at least 10/u);
});

await test("verify --service reads one comparison and judges resource levels with the Decision caveat on every verdict", async () => {
  const now = AT + 3 * HOUR;
  const improved = await verify(comparisonFor(CANDIDATE, now, 400, 40), []);
  assert.equal(improved.run.code, 0, improved.run.stdout + improved.run.stderr);
  assert.equal(improved.document.payload?.verdict, "improved");
  assert.equal(improved.document.payload?.caveat, SERVICE_COMPARISON_CAVEAT);
  assert.deepEqual(improved.urls, [`/api/v1/services/web/deployments/${CANDIDATE.id}/comparison?window=1h`]);
  assert.ok(improved.document.warnings?.some(warning => warning.code === "resource-levels-and-work"));
  assert.deepEqual(improved.document.payload?.sources.map(source => source.status), ["unavailable", "unavailable", "available", "unavailable"]);

  const regressed = await verify(comparisonFor(CANDIDATE, now, 40, 400), []);
  assert.equal(regressed.run.code, 7);
  assert.equal(regressed.document.payload?.verdict, "regressed");

  const unchanged = await verify(comparisonFor(CANDIDATE, now, 100, 102), []);
  assert.equal(unchanged.run.code, 6);
  assert.equal(unchanged.document.payload?.verdict, "unchanged");

  const text = await runCliText(comparisonFor(CANDIDATE, now, 400, 40));
  assert.match(text, /service verdict improved/u);
  assert.match(text, /per-work ratios are descriptive/u);
});

await test("a comparison between git commit markers decodes as the dashboard and verify read it", () => {
  const previous = marker(1, AT - 2 * HOUR, "64b6076b3ebbf6ecced0b62712d46fa60cce52d6");
  const candidate = marker(2, AT, "21271f5b889b1ae1dbc058d89158828ad653d3af");
  const { before, after } = comparisonBounds(candidate.atMs, "1h");
  const value = compareServiceDeployment({ service: "web", deployment: candidate, deployments: [previous, candidate], hostIds: [HOST], hostRollups: () => [], probeRows: [...probeRows(before, 40, 1), ...probeRows(after, 40, 1)], probeSource: "probed", window: "1h", now: AT + 3 * HOUR, truncated: false, applicationEvents: [] });
  const decoded = decodeServiceComparison(JSON.parse(JSON.stringify(value)), candidate.id, "1h");
  assert.deepEqual(decoded.spec.before.versionIds, ["64b6076b3ebbf6ecced0b62712d46fa60cce52d6"]);
  assert.deepEqual(decoded.spec.after.versionIds, ["21271f5b889b1ae1dbc058d89158828ad653d3af"]);
});

async function runCliText(body: unknown): Promise<string> {
  const origin = await fakeOrigin((_request, response) => sendJson(response, body));
  try {
    const run = await runCli(["verify", "--service", "web", "--deployment", CANDIDATE.id, "--policy", policyFile("policy.json"), "--origin", origin.origin], tokenEnv());
    return run.stdout;
  } finally {
    await origin.close();
  }
}

await test("a source the service lacks is insufficient-data with the reason, never a pass", async () => {
  const now = AT + 3 * HOUR;
  const noProbe = await verify(comparisonFor(CANDIDATE, now, 0, 0, "no-health-url"), []);
  assert.equal(noProbe.run.code, 5);
  assert.equal(noProbe.document.payload?.verdict, "insufficient-data");
  assert.match(noProbe.document.payload?.reasons[0]?.message ?? "", /probe unavailable, The service has no health URL/u);
  assert.equal(noProbe.document.payload?.target.before, null);

  const hostMetric = await verify(comparisonFor(CANDIDATE, now, 40, 40), [], policyFile("host.json", { metric: "host.cpu", floor: 2 }));
  assert.equal(hostMetric.run.code, 5);
  assert.match(hostMetric.document.payload?.reasons[0]?.message ?? "", /hosts unavailable/u);
});

function cgroupRollups(deployment: Deployment, beforeCores: number, afterCores: number): Map<string, MinuteRollup[]> {
  const { before, after } = comparisonBounds(deployment.atMs, "1h");
  const minutes: MinuteRollup[] = [];
  for (const [window, cores] of [[before, beforeCores], [after, afterCores]] as const) {
    for (let bucketMs = window.fromMs; bucketMs < window.toMs; bucketMs += 60_000) {
      minutes.push({ bucketMs, payload: { v: 1, bucketMs, samples: 4, coverageMs: 60_000, partial: false, gauges: {}, psi: {}, disks: {}, nets: {}, filesystems: {}, services: { web: { cpu: { usec: String(cores * 60_000_000), coveredMs: 60_000 } } } } });
    }
  }
  return new Map([[HOST, minutes]]);
}

await test("a host policy whose metric the service's cgroup supersedes is still judged and says so, and the cgroup metric is judged", async () => {
  const now = AT + 3 * HOUR;
  const body = compareServiceDeployment({ service: "web", deployment: CANDIDATE, deployments: [PREVIOUS, CANDIDATE], hostIds: [HOST], hostRollups: (() => { const rollups = cgroupRollups(CANDIDATE, 1, 0.5); return (hostId: string) => rollups.get(hostId) ?? []; })(), probeRows: [], probeSource: "no-health-url", window: "1h", now, truncated: false });
  const answerable = { ...body, metrics: body.metrics.map(entry => entry.metric === "host.cpu" ? { ...entry, before: 40, after: 20, delta: -20, deltaPercent: -50, verdict: "improved" as const } : entry) };
  assert.equal(body.metrics.find(entry => entry.metric === "host.cpu")?.supersededBy, "service.cpu");
  const superseded = await verify(answerable, [], policyFile("superseded.json", { metric: "host.cpu", floor: 2 }));
  assert.equal(superseded.run.code, 0, superseded.run.stdout);
  assert.equal(superseded.document.payload?.verdict, "improved");
  assert.match(superseded.document.payload?.reasons[0]?.message ?? "", /host\.cpu is judged as asked.* service\.cpu is the better measure/u);
  const cgroup = await verify(body, [], policyFile("cgroup.json", { metric: "service.cpu", floor: 0.02 }));
  assert.equal(cgroup.run.code, 0, cgroup.run.stdout);
  assert.equal(cgroup.document.payload?.verdict, "improved");
  assert.deepEqual(cgroup.document.payload?.sources.map(source => [source.source, source.status]), [["hosts", "unavailable"], ["cgroup", "available"], ["probe", "unavailable"], ["application", "unavailable"]]);
});

await test("application work is summarised per successful operation, and a cgroup resource is divided by work only when one operation owns it", () => {
  const now = AT + 3 * HOUR;
  const { before, after } = comparisonBounds(CANDIDATE.atMs, "1h");
  const events = [...workEvents(before, "note.save", 20, { saves: 1 }, "before"), ...workEvents(after, "note.save", 10, { saves: 1 }, "after")];
  const rollups = cgroupRollups(CANDIDATE, 1, 0.5);
  const body = comparisonFor(CANDIDATE, now, 0, 0, "no-health-url", events, hostId => rollups.get(hostId) ?? []);
  assert.equal(body.work.length, 1);
  assert.equal(body.work[0]?.operation, "note.save");
  assert.equal(body.work[0]?.before.meanDurationMs, 20);
  assert.equal(body.work[0]?.after.meanDurationMs, 10);
  assert.equal(body.work[0]?.before.work[0]?.durationPerUnitMs, 20);
  assert.equal(body.work[0]?.after.work[0]?.durationPerUnitMs, 10);
  assert.equal(body.metrics.find(metric => metric.metric === "application.note.save.duration")?.verdict, "improved");
  assert.equal(body.metrics.find(metric => metric.metric === "application.note.save.saves.duration")?.verdict, "improved");
  const cpu = body.metrics.find(metric => metric.metric === "application.note.save.saves.cpu");
  assert.ok(cpu !== undefined);
  assert.ok(cpu.before !== null && cpu.after !== null);
  assert.ok(cpu.before > cpu.after);
  assert.deepEqual(body.sources.map(source => [source.source, source.status]), [["hosts", "unavailable"], ["cgroup", "available"], ["probe", "unavailable"], ["application", "available"]]);
});

await test("an incomplete work counter and a shared cgroup make their ratios unavailable with the reason, never zero", () => {
  const now = AT + 3 * HOUR;
  const { before, after } = comparisonBounds(CANDIDATE.atMs, "1h");
  const incomplete = [...workEvents(before, "note.save", 20, { saves: 1 }, "incomplete"), applicationEvent("missing-saves", before.fromMs + 1, "note.save", 20, {})];
  const incompleteBody = comparisonFor(CANDIDATE, now, 0, 0, "no-health-url", incomplete, hostId => cgroupRollups(CANDIDATE, 1, 0.5).get(hostId) ?? []);
  const incompleteMeasurement = incompleteBody.work[0]?.before.work[0];
  assert.equal(incompleteMeasurement?.complete, false);
  assert.equal(incompleteMeasurement?.durationPerUnitMs, null);
  assert.match(incompleteMeasurement?.reason ?? "", /incomplete/u);
  const incompleteMetric = incompleteBody.metrics.find(metric => metric.metric === "application.note.save.saves.duration");
  assert.equal(incompleteMetric?.before, null);
  assert.match(incompleteMetric?.reason ?? "", /incomplete/u);

  const shared = [...workEvents(before, "note.save", 20, { saves: 1 }, "save"), ...workEvents(before, "note.open", 20, { reads: 1 }, "open"), ...workEvents(after, "note.save", 10, { saves: 1 }, "save-after"), ...workEvents(after, "note.open", 10, { reads: 1 }, "open-after")];
  const sharedBody = comparisonFor(CANDIDATE, now, 0, 0, "no-health-url", shared, hostId => cgroupRollups(CANDIDATE, 1, 0.5).get(hostId) ?? []);
  const sharedCpu = sharedBody.metrics.find(metric => metric.metric === "application.note.save.saves.cpu");
  assert.equal(sharedCpu?.before, null);
  assert.match(sharedCpu?.reason ?? "", /cgroup covers 2 operations/u);
  assert.equal(sharedBody.metrics.find(metric => metric.metric === "application.note.save.duration")?.verdict, "improved");
});

await test("work policies require an operation and, for per-work metrics, a work key; level metrics reject both", () => {
  const policy = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: "statsctl-policy/1", id: "work", hypothesis: "Saving a note takes less work after the change.", service: "web",
    metric: "application.durationPerWork", operation: "note.save", work: "saves", direction: "decrease", minChangePercent: 10, floor: 0.01, window: "1h", ...over
  });
  assert.equal(parseServicePolicyText(policy()).operation, "note.save");
  assert.equal(parseServicePolicyText(policy()).work, "saves");
  assert.throws(() => parseServicePolicyText(policy({ operation: undefined })), /operation must be/u);
  assert.throws(() => parseServicePolicyText(policy({ work: undefined })), /work must be/u);
  assert.throws(() => parseServicePolicyText(policy({ metric: "application.duration", work: "saves" })), /remove work/u);
  assert.throws(() => parseServicePolicyText(policy({ metric: "host.cpu", operation: "note.save", work: "saves" })), /remove operation and work/u);
  assert.throws(() => parseServicePolicyText(policy({ operation: "Note.Save" })), /operation must be/u);
});

await test("verify --service judges a typed per-work metric and reports an incomplete counter as insufficient data", async () => {
  const now = AT + 3 * HOUR;
  const { before, after } = comparisonBounds(CANDIDATE.atMs, "1h");
  const events = [...workEvents(before, "note.save", 20, { saves: 1 }, "policy-before"), ...workEvents(after, "note.save", 10, { saves: 1 }, "policy-after")];
  const body = comparisonFor(CANDIDATE, now, 0, 0, "no-health-url", events);
  const workPolicy = policyFile("work.json", { metric: "application.durationPerWork", operation: "note.save", work: "saves", floor: 0.01 });
  const improved = await verify(body, [], workPolicy);
  assert.equal(improved.run.code, 0, improved.run.stdout + improved.run.stderr);
  assert.equal(improved.document.payload?.verdict, "improved");
  assert.equal(improved.document.payload?.target.before, 20);
  assert.equal(improved.document.payload?.target.after, 10);

  const incomplete = [...workEvents(before, "note.save", 20, { saves: 1 }, "policy-incomplete"), applicationEvent("policy-missing", before.fromMs + 1, "note.save", 20, {}), ...workEvents(after, "note.save", 10, { saves: 1 }, "policy-after-complete")];
  const incompleteBody = comparisonFor(CANDIDATE, now, 0, 0, "no-health-url", incomplete);
  const insufficient = await verify(incompleteBody, [], workPolicy);
  assert.equal(insufficient.run.code, 5, insufficient.run.stdout);
  assert.equal(insufficient.document.payload?.verdict, "insufficient-data");
  assert.ok(insufficient.document.payload?.reasons.some(reason => reason.code === "target-unavailable" && /incomplete/u.test(reason.message)));
});

await test("a window that has not settled is pending and exits 5", async () => {
  const fresh = marker(3, Date.now() - 10 * 60_000, "1.2.0");
  const pending = await verify(comparisonFor(fresh, Date.now(), 100, 100), [], policyFile("policy.json"), fresh.id);
  assert.equal(pending.run.code, 5, pending.run.stdout);
  assert.equal(pending.document.payload?.verdict, "pending");
});

await test("--service refuses --project, --wait, and a policy for another service, and project verify refuses a Node origin", async () => {
  const policy = policyFile("policy.json");
  const base = ["verify", "--service", "web", "--deployment", CANDIDATE.id, "--policy", policy, "--json"];
  for (const extra of [["--project", "stats"], ["--wait"], ["--readiness"], ["--safety-check-file", "x"]]) {
    const run = await runCli([...base, ...extra], tokenEnv());
    assert.equal(run.code, 2, extra.join(" "));
  }
  const other = await runCli(["verify", "--service", "api", "--deployment", CANDIDATE.id, "--policy", policy, "--json"], tokenEnv());
  assert.equal(other.code, 2);
  assert.match(other.stderr, /policy is for service web, not api/u);
  const node = await runCli(["verify", "--project", "stats", "--deployment", CANDIDATE.id, "--policy", policy, "--origin", "http://threadripper:18790", "--json"], tokenEnv());
  assert.equal(node.code, 2);
  assert.equal((JSON.parse(node.stdout) as Document).error?.code, "unsupported_on_target");
});

function withApplicationRead(read: { readonly applicationTruncated?: boolean; readonly applicationProblem?: string }, events: readonly ExternalEventRecord[]) {
  const { before, after } = comparisonBounds(CANDIDATE.atMs, "1h");
  const rollups = cgroupRollups(CANDIDATE, 1, 0.5);
  return compareServiceDeployment({ service: "web", deployment: CANDIDATE, deployments: [PREVIOUS, CANDIDATE], hostIds: [HOST], hostRollups: hostId => rollups.get(hostId) ?? [], probeRows: [...probeRows(before, 40, 1), ...probeRows(after, 40, 1)], probeSource: "probed", window: "1h", now: AT + 3 * HOUR, truncated: false, applicationEvents: events, ...read });
}

function completeEvents(): ExternalEventRecord[] {
  const { before, after } = comparisonBounds(CANDIDATE.atMs, "1h");
  return [...workEvents(before, "note.save", 20, { saves: 1 }, "b"), ...workEvents(after, "note.save", 10, { saves: 1 }, "a")];
}

const WORK_POLICY = { metric: "application.cpuPerWork", operation: "note.save", work: "saves", floor: 0.0001 };

for (const [name, read, code] of [
  ["a truncated application read", { applicationTruncated: true }, "application-truncated"],
  ["a failed application read", { applicationProblem: "the observe store did not answer" }, "application-unavailable"]
] as const) {
  await test(`${name} suppresses every application-derived metric and the verdicts that depend on them, and keeps host and cgroup levels`, async () => {
    const body = withApplicationRead(read, completeEvents());
    assert.equal(body.applicationSuppression?.code, code);
    assert.equal(body.applicationCoverage, null);
    assert.deepEqual(body.work, []);
    assert.deepEqual(body.metrics.filter(metric => metric.metric.startsWith("application.")), []);
    assert.equal(body.metrics.find(metric => metric.metric === "service.cpu")?.verdict, "improved");
    assert.equal(body.sources.find(source => source.source === "application")?.status, "unavailable");
    if (code === "application-truncated") assert.equal(body.applicationSuppression?.detail, "Application telemetry for these windows exceeded the 5000-event read limit; partial events are withheld.");
    const verdict = await verify(body, [], policyFile(`${code}.json`, WORK_POLICY));
    assert.equal(verdict.run.code, 5, verdict.run.stdout);
    assert.equal(verdict.document.payload?.verdict, "insufficient-data");
    assert.equal(verdict.document.payload?.target.before, null);
    assert.ok(verdict.document.payload?.reasons.some(reason => reason.code === code));
    const duration = await verify(body, [], policyFile(`${code}-duration.json`, { metric: "application.duration", operation: "note.save", floor: 1 }));
    assert.equal(duration.document.payload?.verdict, "insufficient-data");
  });
}

await test("a window with application gaps while the service was up is not complete coverage and withholds CPU and I/O per work", async () => {
  const { after } = comparisonBounds(CANDIDATE.atMs, "1h");
  const silent = new Set([after.fromMs + 2 * DEPLOYMENT_BUCKET_MS, after.fromMs + 5 * DEPLOYMENT_BUCKET_MS]);
  const events = completeEvents().filter(record => !silent.has(Math.floor(record.event.atMs / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS));
  const body = withApplicationRead({}, events);
  assert.equal(body.applicationCoverage?.after.completeness, "gaps-observed");
  assert.equal(body.applicationCoverage?.after.emptyBucketsWhileUp, 2);
  assert.equal(body.applicationCoverage?.before.emptyBucketsWhileUp, 0);
  for (const name of ["cpu", "io"]) {
    const metric = body.metrics.find(entry => entry.metric === `application.note.save.saves.${name}`);
    assert.equal(metric?.after, null);
    assert.equal(metric?.verdict, "insufficient-data");
    assert.equal(metric?.reasonCode, "application-gap");
    assert.equal(metric?.basis, "observed-work");
  }
  assert.notEqual(body.metrics.find(entry => entry.metric === "application.note.save.saves.duration")?.after, null);
  const verdict = await verify(body, [], policyFile("gap.json", WORK_POLICY));
  assert.equal(verdict.document.payload?.verdict, "insufficient-data");
  assert.ok(verdict.document.payload?.reasons.some(reason => reason.code === "application-gap" && /2 of 12 after/u.test(reason.message)));
});

await test("a clean window compares per-work CPU as before but labels it per observed work and never claims completeness", async () => {
  const body = withApplicationRead({}, completeEvents());
  assert.equal(body.applicationSuppression, null);
  assert.equal(body.applicationCoverage?.before.completeness, "unproven");
  assert.equal(body.applicationCoverage?.after.completeness, "unproven");
  assert.equal(body.applicationCoverage?.after.emptyBucketsWhileUp, 0);
  assert.deepEqual(body.applicationCoverage?.after.unrecorded, ["producer-drops", "rejected-batches", "sequence-gaps"]);
  const cpu = body.metrics.find(entry => entry.metric === "application.note.save.saves.cpu");
  assert.equal(cpu?.verdict, "improved");
  assert.equal(cpu?.basis, "observed-work");
  assert.equal(cpu?.reasonCode, undefined);
  assert.match(cpu?.label ?? "", /per observed saves/u);
  assert.equal(body.metrics.find(entry => entry.metric === "application.note.save.saves.duration")?.basis, undefined);
  const verdict = await verify(body, [], policyFile("clean.json", WORK_POLICY));
  assert.equal(verdict.document.payload?.verdict, "improved");
  assert.ok(verdict.document.payload?.reasons.some(reason => reason.code === "observed-work" && /producer-drops/u.test(reason.message)));
});
