import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { comparisonBounds, DEPLOYMENT_BUCKET_MS } from "../../src/deployments/compare.ts";
import type { ServiceComparison } from "../../src/deployments/service-compare.ts";
import { openNodeInstallation } from "../../src/node/installation.ts";
import { nextProbeAtMs } from "../../src/node/probes.ts";
import type { ProbeFetch } from "../../src/projects/probes.ts";
import { HostSeries, SAMPLE_STEP_MS, SAMPLES_PER_BUCKET, type HostLevels } from "../support/service-data.ts";
import { ingestRequest, NOW_MS, openHarness, scratchDirectory, type Harness } from "./support.ts";

const HOUR = 3_600_000;
const BEFORE: HostLevels = { cpuPercent: 20, memoryUsedPercent: 40, netBytesPerSec: 1_000_000, diskBytesPerSec: 500_000, cpuPressure: 1 };
const AFTER: HostLevels = { ...BEFORE, cpuPercent: 50, netBytesPerSec: 2_000_000 };
const JSON_HEADERS = { "Content-Type": "application/json" };

async function createHost(harness: Harness, name: string): Promise<{ hostId: string; token: string }> {
  const created = await harness.core.createHost(name);
  assert.ok(created.ok);
  return created.value;
}

async function createService(harness: Harness, body: Record<string, unknown>): Promise<string> {
  const response = await harness.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }));
  assert.equal(response.status, 201);
  return (await response.json() as { token: string }).token;
}

async function mark(harness: Harness, service: string, token: string, markerId: string, version: string, hostIds: readonly string[], atMs: number): Promise<string> {
  harness.setNow(atMs);
  const response = await harness.core.fetch(new Request(`https://installation/services/${service}/deployments`, { method: "POST", headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }, body: JSON.stringify({ markerId, version, hostIds }) }));
  assert.equal(response.status, 201);
  return (await response.json() as { deployment: { id: string } }).deployment.id;
}

async function ingestWindow(harness: Harness, host: { hostId: string; token: string }, bounds: { fromMs: number; toMs: number }, levelsAt: (bucketMs: number) => HostLevels, series = new HostSeries(host.hostId)): Promise<void> {
  for (let bucketMs = bounds.fromMs; bucketMs < bounds.toMs; bucketMs += DEPLOYMENT_BUCKET_MS) {
    harness.setNow(bucketMs + SAMPLES_PER_BUCKET * SAMPLE_STEP_MS);
    const response = await harness.core.fetch(ingestRequest(host.token, series.bucketFrame(bucketMs, levelsAt(bucketMs))));
    assert.equal(response.status, 200);
  }
}

async function comparison(harness: Harness, service: string, deploymentId: string, search = "window=1h"): Promise<ServiceComparison> {
  const response = await harness.core.fetch(new Request(`https://installation/services/${service}/deployments/${deploymentId}/comparison?${search}`));
  assert.equal(response.status, 200);
  return await response.json() as ServiceComparison;
}

function metric(result: ServiceComparison, name: string) {
  const found = result.metrics.find(entry => entry.metric === name);
  assert.ok(found !== undefined, name);
  return found;
}

const SECOND_MARKER_AT_MS = NOW_MS - 2 * HOUR;
const FIRST_MARKER_AT_MS = NOW_MS - 4 * HOUR;

await test("a service comparison reports host level changes around a marker and marks absent sources unavailable, never zero", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "web-1");
    const token = await createService(harness, { name: "web", hostIds: [host.hostId] });
    await mark(harness, "web", token, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const deploymentId = await mark(harness, "web", token, "v2", "1.1.0", [host.hostId], SECOND_MARKER_AT_MS);
    const { before, after } = comparisonBounds(SECOND_MARKER_AT_MS, "1h");
    const series = new HostSeries(host.hostId);
    await ingestWindow(harness, host, before, () => BEFORE, series);
    await ingestWindow(harness, host, after, () => AFTER, series);
    harness.setNow(NOW_MS);

    const result = await comparison(harness, "web", deploymentId);
    assert.deepEqual(result.reasonCodes, []);
    assert.equal(result.beforeInvocations, null);
    assert.equal(metric(result, "host.cpu").verdict, "regressed");
    assert.ok(Math.abs(metric(result, "host.cpu").before! - 20) < 1);
    assert.ok(Math.abs(metric(result, "host.cpu").after! - 50) < 1);
    assert.equal(metric(result, "host.memory").verdict, "unchanged");
    assert.equal(metric(result, "host.net").verdict, "regressed");
    assert.equal(metric(result, "host.pressure.memory").before, null);
    assert.equal(metric(result, "host.pressure.memory").verdict, "insufficient-data");
    assert.equal(metric(result, "probe.health.ms").before, null);
    assert.deepEqual(result.sources.map(source => [source.source, source.status]), [["hosts", "available"], ["cgroup", "unavailable"], ["probe", "unavailable"]]);
    assert.ok(result.metrics.every(entry => !entry.metric.startsWith("service.")));
    assert.match(result.sources[2]!.detail, /no health URL/u);
    assert.ok(result.warnings.some(warning => /fewer resources for the same work/u.test(warning)));
    assert.deepEqual(result.hostIds, [host.hostId]);
  } finally {
    harness.close();
  }
});

await test("a service's cgroup series replaces the host series it covers when both windows have it, and the sources say which was used", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "api-1");
    const token = await createService(harness, { name: "api", hostIds: [host.hostId], unit: "api.service" });
    await mark(harness, "api", token, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const deploymentId = await mark(harness, "api", token, "v2", "1.1.0", [host.hostId], SECOND_MARKER_AT_MS);
    const { before, after } = comparisonBounds(SECOND_MARKER_AT_MS, "1h");
    const cgroup = { name: "api", cpuCores: 0.5, memoryBytes: 100_000_000, ioBytesPerSec: 0 };
    const series = new HostSeries(host.hostId);
    await ingestWindow(harness, host, before, () => ({ ...BEFORE, service: cgroup }), series);
    await ingestWindow(harness, host, after, () => ({ ...AFTER, service: { ...cgroup, cpuCores: 0.25, memoryBytes: 200_000_000 } }), series);
    harness.setNow(NOW_MS);

    const result = await comparison(harness, "api", deploymentId);
    assert.deepEqual(result.reasonCodes, []);
    assert.deepEqual(result.metrics.map(entry => entry.metric), ["service.cpu", "service.memory", "host.pressure.cpu", "host.pressure.memory", "host.pressure.io", "host.net", "service.io", "probe.health.ms", "probe.health.failure", "host.cpu", "host.memory", "host.disk"]);
    assert.deepEqual(result.metrics.filter(entry => entry.supersededBy !== undefined).map(entry => [entry.metric, entry.supersededBy]), [["host.cpu", "service.cpu"], ["host.memory", "service.memory"], ["host.disk", "service.io"]]);
    assert.equal(metric(result, "host.cpu").verdict, "regressed");
    assert.ok(Math.abs(metric(result, "host.cpu").after! - 50) < 1);
    assert.ok(Math.abs(metric(result, "service.cpu").before! - 0.5) < 0.01);
    assert.ok(Math.abs(metric(result, "service.cpu").after! - 0.25) < 0.01);
    assert.equal(metric(result, "service.cpu").verdict, "improved");
    assert.equal(metric(result, "service.memory").verdict, "regressed");
    assert.equal(metric(result, "service.io").before, 0);
    assert.equal(metric(result, "service.io").verdict, "unchanged");
    assert.deepEqual(result.sources.map(source => [source.source, source.status]), [["hosts", "available"], ["cgroup", "available"], ["probe", "unavailable"]]);
    assert.match(result.sources[1]!.detail, /^api cgroup on 1 host, used for service\.cpu, service\.memory, service\.io$/u);
    assert.ok(result.warnings.some(warning => /cgroup metrics cover only the processes in the service's unit/u.test(warning)));

    const other = await createService(harness, { name: "other", hostIds: [host.hostId] });
    await mark(harness, "other", other, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const otherId = await mark(harness, "other", other, "v2", "1.1.0", [host.hostId], SECOND_MARKER_AT_MS);
    harness.setNow(NOW_MS);
    const hostOnly = await comparison(harness, "other", otherId);
    assert.equal(metric(hostOnly, "host.cpu").verdict, "regressed");
    assert.equal(hostOnly.sources[1]!.status, "unavailable");
  } finally {
    harness.close();
  }
});

await test("a cgroup that reports in only one window leaves the host series in place, never a zero baseline", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "rollout-1");
    const token = await createService(harness, { name: "rollout", hostIds: [host.hostId] });
    await mark(harness, "rollout", token, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const deploymentId = await mark(harness, "rollout", token, "v2", "1.1.0", [host.hostId], SECOND_MARKER_AT_MS);
    const { before, after } = comparisonBounds(SECOND_MARKER_AT_MS, "1h");
    const series = new HostSeries(host.hostId);
    await ingestWindow(harness, host, before, () => BEFORE, series);
    await ingestWindow(harness, host, after, () => ({ ...AFTER, service: { name: "rollout", cpuCores: 0.25, memoryBytes: 1, ioBytesPerSec: 0 } }), series);
    harness.setNow(NOW_MS);
    const result = await comparison(harness, "rollout", deploymentId);
    assert.equal(metric(result, "host.cpu").verdict, "regressed");
    assert.ok(result.metrics.every(entry => !entry.metric.startsWith("service.")));
    assert.equal(result.sources[1]!.status, "unavailable");
  } finally {
    harness.close();
  }
});

await test("a service comparison with no host data says so and invents no values", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "silent");
    const token = await createService(harness, { name: "quiet", hostIds: [host.hostId] });
    await mark(harness, "quiet", token, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const deploymentId = await mark(harness, "quiet", token, "v2", "1.1.0", [host.hostId], SECOND_MARKER_AT_MS);
    harness.setNow(NOW_MS);
    const result = await comparison(harness, "quiet", deploymentId);
    assert.ok(result.reasonCodes.includes("no-data"));
    assert.ok(result.metrics.every(entry => entry.before === null && entry.after === null && entry.verdict === "insufficient-data"));
    assert.deepEqual(result.sources.map(source => source.status), ["unavailable", "unavailable", "unavailable"]);
  } finally {
    harness.close();
  }
});

await test("a service comparison withholds a verdict before the after window settles and for a first marker with no baseline", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "fresh");
    const token = await createService(harness, { name: "fresh", hostIds: [host.hostId] });
    const first = await mark(harness, "fresh", token, "v1", "1.0.0", [host.hostId], NOW_MS - 10 * 60_000);
    harness.setNow(NOW_MS);
    const early = await comparison(harness, "fresh", first);
    assert.ok(early.reasonCodes.includes("not-ready"));
    assert.ok(early.reasonCodes.includes("baseline-missing"));
    assert.ok(early.metrics.every(entry => entry.verdict === "insufficient-data" || entry.verdict === "confounded"));
  } finally {
    harness.close();
  }
});

await test("probe results land in the comparison, and a failing probe after the marker regresses the failure share", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "probed");
    const token = await createService(harness, { name: "probed", hostIds: [host.hostId], healthUrl: "https://probed.example.com/health" });
    await mark(harness, "probed", token, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const deploymentId = await mark(harness, "probed", token, "v2", "1.1.0", [host.hostId], SECOND_MARKER_AT_MS);
    const { before, after } = comparisonBounds(SECOND_MARKER_AT_MS, "1h");
    let latencyMs = 0;
    let status = 200;
    const fetched: string[] = [];
    let currentNow = 0;
    const probeFetch: ProbeFetch = async (url) => {
      fetched.push(url);
      harness.setNow(currentNow + latencyMs);
      return { status, body: null };
    };
    for (const [window, probeStatus, probeLatency] of [[before, 200, 40], [after, 503, 400]] as const) {
      status = probeStatus;
      latencyMs = probeLatency;
      for (let bucketMs = window.fromMs; bucketMs < window.toMs; bucketMs += DEPLOYMENT_BUCKET_MS) {
        currentNow = bucketMs + 1000;
        harness.setNow(currentNow);
        await harness.core.collectServiceProbes(probeFetch);
      }
    }
    harness.setNow(NOW_MS);
    assert.ok(fetched.every(url => url === "https://probed.example.com/health"));
    const result = await comparison(harness, "probed", deploymentId);
    assert.equal(metric(result, "probe.health.ms").before, 40);
    assert.equal(metric(result, "probe.health.ms").after, 400);
    assert.equal(metric(result, "probe.health.ms").verdict, "regressed");
    assert.equal(metric(result, "probe.health.failure").before, 0);
    assert.equal(metric(result, "probe.health.failure").after, 100);
    assert.equal(metric(result, "probe.health.failure").verdict, "regressed");
    assert.deepEqual(result.sources.map(source => [source.source, source.status]), [["hosts", "unavailable"], ["cgroup", "unavailable"], ["probe", "available"]]);
  } finally {
    harness.close();
  }
});

await test("the service comparison route rejects a bad id, window, method, and unknown service or deployment", async () => {
  const harness = openHarness();
  try {
    const host = await createHost(harness, "routes");
    const token = await createService(harness, { name: "routes", hostIds: [host.hostId] });
    const id = await mark(harness, "routes", token, "v1", "1.0.0", [host.hostId], FIRST_MARKER_AT_MS);
    const status = async (path: string, method = "GET") => (await harness.core.fetch(new Request(`https://installation${path}`, { method }))).status;
    assert.equal(await status(`/services/routes/deployments/${id}/comparison`), 200);
    assert.equal(await status(`/services/routes/deployments/${id}/comparison?window=2h`), 400);
    assert.equal(await status(`/services/routes/deployments/${id}/comparison?window=1h&window=6h`), 400);
    assert.equal(await status(`/services/routes/deployments/${id}/comparison?other=1`), 400);
    assert.equal(await status("/services/routes/deployments/not-a-uuid/comparison"), 400);
    assert.equal(await status("/services/routes/deployments/00000000-0000-4000-8000-000000000000/comparison"), 404);
    assert.equal(await status(`/services/absent/deployments/${id}/comparison`), 404);
    assert.equal(await status(`/services/routes/deployments/${id}/comparison`, "POST"), 405);
  } finally {
    harness.close();
  }
});

await test("the Node server probes services on the five-minute boundary with the injected clock and fetch, and stops on close", async () => {
  const start = Math.floor(NOW_MS / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS + 60_000;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const directory = scratchDirectory("probe-schedule");
  const calls: number[] = [];
  const installation = openNodeInstallation({
    path: `${directory}/stats.sqlite`,
    projects: "[]",
    clock: { now: () => Date.now() },
    probeFetch: async () => {
      calls.push(Date.now());
      return { status: 200, body: null };
    }
  });
  try {
    const host = await installation.core.createHost("node-probe");
    assert.ok(host.ok);
    const created = await installation.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "probe-me", hostIds: [host.value.hostId], healthUrl: "https://probe-me.example.com/up" }) }));
    assert.equal(created.status, 201);
    assert.equal(nextProbeAtMs(start), start - 60_000 + DEPLOYMENT_BUCKET_MS);
    mock.timers.tick(DEPLOYMENT_BUCKET_MS - 60_000 - 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, []);
    mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [start - 60_000 + DEPLOYMENT_BUCKET_MS]);
    mock.timers.tick(DEPLOYMENT_BUCKET_MS);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    installation.close();
    mock.timers.tick(DEPLOYMENT_BUCKET_MS * 2);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
  } finally {
    mock.timers.reset();
  }
});
