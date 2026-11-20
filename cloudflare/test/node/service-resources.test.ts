import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOYMENT_BUCKET_MS } from "../../src/deployments/compare.ts";
import type { HostServiceResources } from "../../src/core/installation/service-resources-model.ts";
import type { ServiceHealthHistory } from "../../src/core/installation/service-health-model.ts";
import type { Service } from "../../src/core/installation/services.ts";
import { openNodeInstallation } from "../../src/node/installation.ts";
import { HostSeries, SAMPLE_STEP_MS, SAMPLES_PER_BUCKET, type HostLevels } from "../support/service-data.ts";
import { ingestRequest, NOW_MS, openHarness, scratchDirectory } from "./support.ts";

const HOUR = 3_600_000;
const LEVELS: HostLevels = { cpuPercent: 20, memoryUsedPercent: 40, netBytesPerSec: 1_000_000, diskBytesPerSec: 500_000, cpuPressure: 1 };
const JSON_HEADERS = { "Content-Type": "application/json" };

await test("host service resources report each cgroup's CPU cores, memory and I/O per step, leaving unreported steps null", async () => {
  const harness = openHarness();
  try {
    const created = await harness.core.createHost("lisa");
    assert.ok(created.ok);
    const host = created.value;
    const series = new HostSeries(host.hostId);
    const fromMs = NOW_MS - 2 * HOUR;
    const reportedUntil = NOW_MS - HOUR;
    for (let bucketMs = fromMs; bucketMs < reportedUntil; bucketMs += DEPLOYMENT_BUCKET_MS) {
      harness.setNow(bucketMs + SAMPLES_PER_BUCKET * SAMPLE_STEP_MS);
      const response = await harness.core.fetch(ingestRequest(host.token, series.bucketFrame(bucketMs, { ...LEVELS, service: { name: "oo-engine", cpuCores: 1.5, memoryBytes: 2_000_000_000, ioBytesPerSec: 400_000 } })));
      assert.equal(response.status, 200);
    }
    harness.setNow(NOW_MS);

    const response = await harness.core.fetch(new Request(`https://installation/hosts/${host.hostId}/services?fromMs=${fromMs}&toMs=${NOW_MS}`));
    assert.equal(response.status, 200);
    const body = await response.json() as HostServiceResources;
    assert.equal(body.resolution, "1m");
    assert.deepEqual(body.services.map(service => service.name), ["oo-engine"]);
    const points = body.services[0]!.points;
    const reported = points.filter(point => point.atMs >= fromMs + DEPLOYMENT_BUCKET_MS && point.atMs < reportedUntil - DEPLOYMENT_BUCKET_MS);
    assert.ok(reported.length > 0);
    for (const point of reported) {
      assert.ok(Math.abs(point.cpuCores! - 1.5) < 0.01, `cpu ${point.cpuCores}`);
      assert.ok(Math.abs(point.memoryBytes! - 2_000_000_000) < 1);
      assert.ok(Math.abs(point.ioBytesPerSec! - 400_000) < 1_000, `io ${point.ioBytesPerSec}`);
    }
    const silent = points.filter(point => point.atMs >= reportedUntil + DEPLOYMENT_BUCKET_MS);
    assert.ok(silent.length > 0);
    assert.ok(silent.every(point => point.cpuCores === null && point.memoryBytes === null && point.ioBytesPerSec === null));

    assert.equal((await harness.core.fetch(new Request(`https://installation/hosts/${host.hostId}/services?fromMs=${NOW_MS}&toMs=${fromMs}`))).status, 400);
    assert.equal((await harness.core.fetch(new Request(`https://installation/hosts/${host.hostId}/services?fromMs=${fromMs}&toMs=${NOW_MS}&extra=1`))).status, 400);
    assert.equal((await harness.core.fetch(new Request(`https://installation/hosts/h_${"0".repeat(32)}/services?fromMs=${fromMs}&toMs=${NOW_MS}`))).status, 404);
  } finally {
    harness.close();
  }
});

await test("a service update changes only the given fields, clears a health URL with null, and rejects unknown hosts without writing", async () => {
  const harness = openHarness();
  try {
    const created = await harness.core.createHost("lisa");
    assert.ok(created.ok);
    const hostId = created.value.hostId;
    const service = await harness.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "discover", hostIds: [hostId], unit: "oo-app.discover" }) }));
    assert.equal(service.status, 201);
    const patch = (body: unknown, name = "discover") => harness.core.fetch(new Request(`https://installation/admin/services/${name}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }));

    const set = await patch({ healthUrl: "https://hq.example.com/healthz" });
    assert.equal(set.status, 200);
    assert.deepEqual(await set.json(), { name: "discover", hostIds: [hostId], healthUrl: "https://hq.example.com/healthz", unit: "oo-app.discover", createdAtMs: NOW_MS });

    assert.equal((await patch({ hostIds: [`h_${"1".repeat(32)}`] })).status, 400);
    assert.equal((await patch({ healthUrl: "http://plain.example.com/" })).status, 400);
    assert.equal((await patch({})).status, 400);
    assert.equal((await patch({ name: "renamed" })).status, 400);
    assert.equal((await patch({ unit: null }, "missing")).status, 404);

    const cleared = await patch({ healthUrl: null });
    assert.equal(cleared.status, 200);
    const read = await (await harness.core.fetch(new Request("https://installation/services/discover"))).json() as Service;
    assert.equal(read.healthUrl, null);
    assert.deepEqual(read.hostIds, [hostId]);
    assert.equal(read.unit, "oo-app.discover");
  } finally {
    harness.close();
  }
});

await test("the service list reports the latest fresh health probe, and unprobed when there is no URL or no recent result", async () => {
  const directory = scratchDirectory("service-health");
  let now = NOW_MS;
  let status = 200;
  const installation = openNodeInstallation({
    path: `${directory}/stats.sqlite`,
    projects: "[]",
    clock: { now: () => now },
    probeFetch: async () => ({ status, body: null })
  });
  try {
    const host = await installation.core.createHost("lisa");
    assert.ok(host.ok);
    for (const body of [{ name: "probed", hostIds: [host.value.hostId], healthUrl: "https://probed.example.com/up" }, { name: "silent", hostIds: [host.value.hostId] }]) {
      assert.equal((await installation.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }))).status, 201);
    }
    const health = async () => Object.fromEntries((await (await installation.core.fetch(new Request("https://installation/services"))).json() as { services: Service[] }).services.map(service => [service.name, service.health?.status]));

    assert.deepEqual(await health(), { probed: "unprobed", silent: "unprobed" });
    await installation.core.collectServiceProbes(async () => ({ status, body: null }));
    assert.deepEqual(await health(), { probed: "up", silent: "unprobed" });
    status = 503;
    now += DEPLOYMENT_BUCKET_MS;
    await installation.core.collectServiceProbes(async () => ({ status, body: null }));
    assert.deepEqual(await health(), { probed: "down", silent: "unprobed" });
    now += HOUR;
    assert.deepEqual(await health(), { probed: "unprobed", silent: "unprobed" });
  } finally {
    installation.close();
  }
});

await test("service health history buckets probe results into bars, counting failures and leaving unprobed bars empty", async () => {
  const directory = scratchDirectory("service-health-bars");
  let now = NOW_MS;
  let status = 200;
  const installation = openNodeInstallation({ path: `${directory}/stats.sqlite`, projects: "[]", clock: { now: () => now }, probeFetch: async () => ({ status, body: null }) });
  try {
    const host = await installation.core.createHost("lisa");
    assert.ok(host.ok);
    assert.equal((await installation.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "web", hostIds: [host.value.hostId], healthUrl: "https://web.example.com/up" }) }))).status, 201);
    const fromMs = now;
    for (const code of [200, 200, 503, 200]) {
      status = code;
      await installation.core.collectServiceProbes(async () => ({ status, body: null }));
      now += DEPLOYMENT_BUCKET_MS;
    }
    const read = async (search: string) => installation.core.fetch(new Request(`https://installation/services/web/health?${search}`));
    const response = await read(`fromMs=${fromMs}&toMs=${now + HOUR}`);
    assert.equal(response.status, 200);
    const history = await response.json() as ServiceHealthHistory;
    assert.equal(history.stepMs, DEPLOYMENT_BUCKET_MS);
    const probed = history.bars.filter(bar => bar.probes > 0);
    assert.deepEqual(probed.map(bar => bar.up), [1, 1, 0, 1]);
    assert.ok(probed.every(bar => bar.meanMs !== null));
    assert.ok(history.bars.some(bar => bar.probes === 0 && bar.meanMs === null), "bars after the last probe stay empty");

    const wide = await (await read(`fromMs=${now - 20 * 24 * HOUR}&toMs=${now}`)).json() as ServiceHealthHistory;
    assert.equal(wide.stepMs % HOUR, 0, "windows beyond sample retention read hourly rollups");
    assert.ok(wide.bars.length <= 60);
    assert.equal((await read(`fromMs=${now}&toMs=${fromMs}`)).status, 400);
    assert.equal((await installation.core.fetch(new Request(`https://installation/services/missing/health?fromMs=${fromMs}&toMs=${now}`))).status, 404);
  } finally {
    installation.close();
  }
});
