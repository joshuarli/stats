import assert from "node:assert/strict";
import { test } from "node:test";
import { handleStatsRequest, type StatsTarget } from "../../src/core/http.ts";
import { handleMetricRequest } from "../../src/metrics/http.ts";
import { MetricStore } from "../../src/metrics/store.ts";

void test("metric writes and reads enforce authorization, media type, limits and strict batches", async () => {
  const store = new MetricStore();
  const token = `nft_${"a".repeat(43)}`;
  const target: StatsTarget = {
    observeExports: false,
    capabilities: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true, infraMetrics: false },
    authorize: request => Promise.resolve(request.headers.get("x-reader") === "yes" ? { ok: true } : { ok: false, status: 401, message: "denied" }),
    authorizeIngest: (_service, supplied) => Promise.resolve(supplied === token),
    serviceExists: () => Promise.resolve(false),
    metricsAvailable: true,
    metrics: request => handleMetricRequest(request, store),
    installation: () => Promise.resolve(new Response(null, { status: 404 })),
    assets: () => Promise.resolve(new Response(null, { status: 404 })),
    observe: null
  };
  const path = "https://stats/ingest/metrics/v1/batches";
  const post = (body: string, headers: Record<string, string> = {}) => handleStatsRequest(new Request(path, { method: "POST", headers, body }), target);
  const auth = { authorization: `Bearer ${token}` };
  const media = { ...auth, "content-type": "application/vnd.stats.infra-metrics.v2+json" };
  try {
    assert.equal((await post("{}", media)).status, 400);
    assert.equal((await post("{}")).status, 401);
    assert.equal((await post("{}", auth)).status, 415);
    assert.equal((await post("x".repeat(65537), media)).status, 413);
    assert.equal((await handleStatsRequest(new Request(path, { method: "POST", body: "{}" }), { ...target, metricsAvailable: false })).status, 503);
    const sources = "https://stats/api/observe/stats-infra/metrics/sources?from=1&to=2&release=runtime";
    assert.equal((await handleStatsRequest(new Request(sources), target)).status, 401);
    const authorizedRead = () => new Request(sources, { headers: { "x-reader": "yes" } });
    assert.equal((await handleStatsRequest(authorizedRead(), { ...target, metricsAvailable: false })).status, 503);
    const read = await handleStatsRequest(authorizedRead(), target);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { sources: [] });
  } finally {
    store.close();
  }
});

void test("Node adapter authenticates metrics and persists outside the installation database", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const { createStatsServer } = await import("../../src/node/server.ts");
  const { tokenHash } = await import("../../src/auth.ts");
  const directory = mkdtempSync(resolve(import.meta.dirname, "../../../.work/tmp/metric-node-"));
  const path = join(directory, "stats-infra.sqlite");
  const store = new MetricStore(path);
  const token = `nft_${"b".repeat(43)}`;
  const server = createStatsServer({
    installation: () => Promise.resolve(new Response(null, { status: 404 })),
    assets: () => Promise.resolve(new Response(null, { status: 404 })),
    transport: "tcp", metricsVerifier: await tokenHash(token), metrics: request => handleMetricRequest(request, store)
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const now = Date.now();
  const batch = {
    schema: "stats-infra-metrics/2", catalog: 1,
    collector: { name: "infra", instance: "0123456789abcdef", startedAtMs: now },
    expected: ["engine:local"], delivery: { atMs: now, queued: 0, queueHigh: 0, targets: { "engine:local": { scraped: 0, accepted: 0, duplicates: 0, rejected: 0, dropped: 0, failed: 0 } } },
    scrapes: [{ target: "engine:local", sequence: 1, atMs: now, monoMs: 1, outcome: "refused", durationUs: 1, bytes: 0,
      release: { runtime: "rt-0123456789ab", app: null }, process: { startTime: null },
      dropped: { unlisted_family: 0, unlisted_label: 0, non_finite: 0, series_cap: 0 }, values: {} }]
  };
  try {
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/ingest/metrics/v1/batches`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.stats.infra-metrics.v2+json" }, body: JSON.stringify(batch) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { accepted: number }).accepted, 1);
    const read = await fetch(`${origin}/api/observe/stats-infra/metrics/sources?from=${now - 1}&to=${Date.now() + 1000}&release=runtime`, { headers: { "Tailscale-User-Login": "reader@example.com" } });
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { sources: unknown[] }).sources.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
  const reopened = new MetricStore(path);
  try {
    assert.equal(reopened.sources(now - 1, Date.now() + 1000, "runtime", Date.now()).length, 1);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
