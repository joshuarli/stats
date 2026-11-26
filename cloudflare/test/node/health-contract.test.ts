import assert from "node:assert/strict";
import { test } from "node:test";
import { probeService } from "../../src/projects/service-probes.ts";
import { createStatsHealth } from "../../src/core/health.ts";
import { migrate } from "../../src/core/installation/schema.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";
import { MetricStore } from "../../src/metrics/store.ts";
import { handleMetricRequest } from "../../src/metrics/http.ts";
import { openHarness } from "./support.ts";

const body = (status: string, service = "web") => JSON.stringify({ status, service, checks: { database: { status: "degraded" } } });

void test("service probes classify contract responses and bound their bodies", async () => {
  for (const [response, expected] of [
    [new Response(body("ok")), "ok"],
    [new Response(body("degraded")), "degraded"],
    [new Response(body("down"), { status: 503 }), "down"],
    [new Response(null, { status: 302 }), "down"],
    [new Response(body("ok", "other")), "down"],
    [Response.json({ status: "ok", service: "web" }), "down"],
    [Response.json({ status: "ok", service: "web", checks: { database: { status: "ok", ms: 1.5 } } }), "down"],
    [Response.json({ status: "ok", service: "web", role: "reader", checks: { store: { status: "ok", ms: 3, region: "a" } } }), "ok"],
    [Response.json({ status: "down", service: "web", checks: {} }), "down"],
    [new Response("not json"), "down"],
    [new Response("x".repeat(4097)), "down"]
  ] as const) {
    const result = await probeService({ name: "web", url: "https://web.example/health", fetch: async () => response, now: 1000 });
    assert.equal(result.status, expected);
  }
  const result = await probeService({ name: "web", url: "https://web.example/health", fetch: async () => new Response(body("degraded")), now: 1000 });
  assert.deepEqual(result.checks, [{ name: "database", status: "degraded" }]);
  const prefix = '{"status":"ok","service":"web","checks":{"';
  const suffix = '":{"status":"ok"}}}';
  const limit = prefix + "x".repeat(4096 - prefix.length - suffix.length) + suffix;
  assert.equal((await probeService({ name: "web", url: "https://web.example/health", fetch: async () => new Response(limit), now: 1000 })).status, "ok");
  const down = await probeService({ name: "web", url: "https://web.example/health", fetch: async () => new Response(body("down"), { status: 503 }), now: 1000 });
  assert.equal(down.reason, "http 503");
  assert.deepEqual(down.checks, [{ name: "database", status: "degraded" }]);
  assert.equal((await probeService({ name: "web", url: "https://web.example/health", fetch: async () => { throw new Error("offline"); }, now: 1000 })).reason, "connection error");
  assert.equal((await probeService({ name: "web", url: "https://web.example/health", fetch: async () => Response.json({ status: "down", service: "web", checks: {} }), now: 1000 })).reason, "reported down");
});

void test("Stats health shares computations, caches for one second and degrades stale probes", async () => {
  let now = 1_000_000;
  let reads = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const health = createStatsHealth({ now: () => now, release: "rev-1", metricsAvailable: true,
    installation: async () => { reads++; await gate; return Response.json({ lastRoundAtMs: 999_999 }); },
    metrics: async () => Response.json({})
  });
  const first = health(), second = health();
  assert.equal(reads, 1);
  release!();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("cache-control"), "no-store");
  assert.deepEqual(await a.json(), await b.json());
  assert.equal((await (await health()).json() as { release: string }).release, "rev-1");
  assert.equal(reads, 1);
  now += 181_000;
  assert.equal((await (await health()).json() as { status: string }).status, "degraded");
  assert.equal(reads, 2);
});

void test("oversized streaming health is cancelled without reading past 4096 bytes", async () => {
  let read = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    type: "bytes",
    pull(controller) {
      const view = controller.byobRequest!.view!;
      const size = Math.min(view.byteLength, 4097 - read);
      new Uint8Array(view.buffer, view.byteOffset, size).fill(120);
      read += size;
      controller.byobRequest!.respond(size);
    },
    cancel() { cancelled = true; }
  });
  const result = await probeService({ name: "web", url: "https://web.example/health", fetch: async () => new Response(stream), now: 1 });
  assert.equal(result.status, "down");
  assert.equal(read, 4096);
  assert.equal(cancelled, true);
});

void test("a stalled response body times out and is cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ type: "bytes", pull() {}, cancel() { cancelled = true; } });
  const result = await probeService({ name: "web", url: "https://web.example/health", fetch: async () => new Response(stream), now: 1 });
  assert.equal(result.status, "down");
  assert.equal(result.reason, "timeout");
  assert.equal(cancelled, true);
});

void test("a service connection times out after two seconds", async () => {
  const result = await probeService({ name: "web", url: "https://web.example/health", now: 1, fetch: () => new Promise(() => {}) });
  assert.equal(result.status, "down");
  assert.equal(result.reason, "timeout");
});

void test("service probes persist latest status and aggregate every result in a bucket", async () => {
  const harness = openHarness("[]", { probesServices: true });
  try {
    const host = await harness.core.createHost("host");
    assert.ok(host.ok);
    const created = await harness.core.fetch(new Request("https://installation/admin/services", { method: "POST", body: JSON.stringify({ name: "web", hostIds: [host.value.hostId], healthUrl: "https://web.example/health" }) }));
    assert.equal(created.status, 201);
    let now = 1_793_510_415_000;
    for (const [state, latency] of [["ok", 20], ["degraded", 90], ["down", 400], ["ok", 10]] as const) {
      harness.setNow(now);
      await harness.core.collectServiceProbes(async () => { now += latency; harness.setNow(now); return state === "down" ? new Response(null, { status: 503 }) : new Response(body(state)); });
      const latest = (await (await harness.core.fetch(new Request("https://installation/services/web"))).json() as { health: { status: string; reason: string | null; checks: unknown[] } }).health;
      assert.equal(latest.status, state);
      if (state === "degraded") assert.deepEqual(latest.checks, [{ name: "database", status: "degraded" }]);
      if (state === "down") assert.equal(latest.reason, "http 503");
    }
    const health = (await (await harness.core.fetch(new Request("https://installation/services/web"))).json() as { health: { status: string } }).health;
    assert.equal(health.status, "ok");
    const rows = harness.db.prepare("SELECT metric, value FROM project_samples WHERE project = 'service:web'").all();
    assert.equal(rows.find(row => row.metric === "probe.health.up")?.value, 0);
    assert.equal(rows.find(row => row.metric === "probe.health.degraded")?.value, 1);
    assert.equal(rows.find(row => row.metric === "probe.health.ms")?.value, 400);
    harness.db.prepare("UPDATE services SET health_url = NULL WHERE name = 'web'").run();
    assert.equal((await (await harness.core.fetch(new Request("https://installation/services/web"))).json() as { health: { status: string } }).health.status, "missing");
  } finally { harness.close(); }
});

void test("overlapping probe rounds skip the second tick", async () => {
  const harness = openHarness("[]", { probesServices: true });
  try {
    const host = await harness.core.createHost("host");
    assert.ok(host.ok);
    assert.equal((await harness.core.fetch(new Request("https://installation/admin/services", { method: "POST", body: JSON.stringify({ name: "web", hostIds: [host.value.hostId], healthUrl: "https://web.example/health" }) }))).status, 201);
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    const fetch = () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); };
    const first = harness.core.collectServiceProbes(fetch);
    await harness.core.collectServiceProbes(fetch);
    assert.equal(calls, 1);
    release!(Response.json({ status: "ok", service: "web", checks: {} }));
    await first;
  } finally { harness.close(); }
});

void test("Stats health bounds an unavailable dependency and reports down without its error", async () => {
  const health = createStatsHealth({ metricsAvailable: true, installation: async () => Response.json({ lastRoundAtMs: Date.now() }), metrics: () => new Promise(() => {}) });
  const response = await health();
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json() as { checks: { metrics: { status: string; detail: string } } }).checks.metrics, { status: "down", detail: "timeout" });
});

void test("Stats health reports a closed configured metrics store as down", async () => {
  const store = new MetricStore();
  store.close();
  const health = createStatsHealth({ metricsAvailable: true, installation: async () => Response.json({ lastRoundAtMs: Date.now() }), metrics: request => handleMetricRequest(request, store) });
  const response = await health();
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { checks: { metrics: { status: string } } }).checks.metrics.status, "down");
});

void test("the forward migration preserves legacy services without a health URL", async () => {
  const harness = openHarness();
  try {
    const host = await harness.core.createHost("host");
    assert.ok(host.ok);
    assert.equal((await harness.core.fetch(new Request("https://installation/admin/services", { method: "POST", body: JSON.stringify({ name: "web", hostIds: [host.value.hostId], healthUrl: "https://web.example/health" }) }))).status, 201);
    harness.db.exec("UPDATE services SET health_url = NULL; DROP TABLE service_probe_results; DROP TABLE service_probe_round; UPDATE schema_version SET version = 10");
    migrate(nodeSqlScopes(harness.db).open());
    assert.equal(harness.db.prepare("SELECT version FROM schema_version").get()!["version"], 11);
    assert.equal((await (await harness.core.fetch(new Request("https://installation/services/web"))).json() as { health: { status: string } }).health.status, "missing");
  } finally { harness.close(); }
});
