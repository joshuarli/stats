import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mock, test } from "node:test";
import { MetricStore } from "../../src/metrics/store.ts";
import { openNodeInstallation } from "../../src/node/installation.ts";
import { NodeRuntime } from "../../src/node/runtime.ts";
import { createStatsServer } from "../../src/node/server.ts";
import { scratchDirectory } from "./support.ts";

await test("runtime samples are stored, expose unavailable data honestly, and require authentication", async () => {
  const directory = scratchDirectory("node-runtime");
  const metrics = new MetricStore(join(directory, "metrics.sqlite"));
  const runtime = new NodeRuntime(() => metrics);
  const installation = openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: "[]", runtime });
  const server = createStatsServer({ installation: request => installation.core.fetch(request), assets: async () => new Response("ok"), transport: "tcp", runtime });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await installation.core.createHost("runtime");
    runtime.sample();
    const sample = runtime.snapshot();
    assert.ok(sample.process.cpuUserUs >= 0);
    assert.ok(sample.process.rssBytes > 0);
    assert.equal(sample.process.openFds === null, process.platform !== "linux");
    assert.equal(sample.sqlite["installation"]!.rowsRead, null);
    assert.ok(sample.sqlite["installation"]!.statements > 0);
    assert.ok(metrics.connection.prepare("SELECT COUNT(*) AS n FROM native_runtime_samples").get()!.n as number > 0);
    const rss = metrics.nativeSeries("rss_bytes", sample.atMs - 10_000, sample.atMs + 10_000);
    assert.equal(rss.length, 1);
    assert.ok(typeof rss[0]!.value === "number" && rss[0]!.value > 0);
    const statements = metrics.nativeSeries("sqlite_statements", sample.atMs - 10_000, sample.atMs + 10_000);
    assert.ok((statements[0]!.value as Record<string, number>)["installation"]! > 0);
    assert.throws(() => metrics.nativeSeries("sqlite_rows_read", 0, Date.now()), RangeError);
    assert.equal((await fetch(`${origin}/api/v1/runtime`)).status, 401);
    const response = await fetch(`${origin}/api/v1/runtime`, { headers: { "tailscale-user-login": "owner@example.com" } });
    assert.equal(response.status, 200);
    const data = await response.json() as { process: { rssBytes: number } };
    assert.ok(data.process.rssBytes > 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.stop();
    await installation.shutdown();
    metrics.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("runtime remains readable when a sample cannot be exported", async () => {
  const runtime = new NodeRuntime(() => { throw new Error("storage unavailable"); });
  const error = mock.method(console, "error", () => {});
  const server = createStatsServer({ installation: async () => new Response(null), assets: async () => new Response(null), transport: "tcp", runtime });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    runtime.sample();
    assert.equal(runtime.snapshot().exportFailures, 1);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/v1/runtime`, { headers: { "tailscale-user-login": "owner@example.com" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { exportFailures: number }).exportFailures, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.stop();
    error.mock.restore();
  }
});

await test("runtime counts active requests, streams and delivered response bytes", async () => {
  const runtime = new NodeRuntime(() => { throw new Error("unused"); });
  let finish: (() => void) | undefined;
  const server = createStatsServer({ installation: async () => new Response(null), transport: "tcp", runtime, assets: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      finish = () => { finish = undefined; controller.enqueue(new TextEncoder().encode("last")); controller.close(); };
    }
  })) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/`, { headers: { "tailscale-user-login": "owner@example.com" } });
    const active = runtime.snapshot();
    assert.equal(active.activeRequests, 1);
    assert.equal(active.inflightStreams, 1);
    assert.equal(active.responseBytes, 5);
    finish!();
    assert.equal(await response.text(), "firstlast");
    await new Promise<void>(resolve => setImmediate(resolve));
    const complete = runtime.snapshot();
    assert.equal(complete.activeRequests, 0);
    assert.equal(complete.inflightStreams, 0);
    assert.equal(complete.responseBytes, 9);
  } finally {
    finish?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.stop();
  }
});
