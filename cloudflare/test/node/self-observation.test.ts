import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { openAssets } from "../../src/node/assets.ts";
import { openNodeInstallation } from "../../src/node/installation.ts";
import { createStatsServer, observeHandler } from "../../src/node/server.ts";
import { scratchDirectory } from "./support.ts";

await test("Node records request operations with linked trace context without observing telemetry ingest", async () => {
  const directory = scratchDirectory("node-self-observation");
  const assets = join(directory, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "stats");
  const installation = openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: "[]", release: "release-123" });
  const server = createStatsServer({ installation: request => installation.core.fetch(request), observe: observeHandler(installation), assets: await openAssets(assets), transport: "tcp", application: installation.application });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { "tailscale-user-login": "owner@example.com", traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` };
  try {
    const created = await installation.core.createHost("synthetic-check");
    assert.ok(created.ok);
    const response = await fetch(`${origin}/api/v1/hosts/${created.value.hostId}/history?range=24h&kind=summary`, { headers });
    assert.equal(response.status, 200);
    await installation.application!.flush();
    const events = (await installation.observe.forService("stats").external("stats", {})).map(row => row.event);
    const invocation = events.find(event => event.operation === "installation.request");
    const operation = events.find(event => event.operation === "host.history");
    assert.ok(invocation?.trace);
    assert.ok(operation?.trace);
    assert.equal(operation.trace.traceId, "a".repeat(32));
    assert.equal(invocation.trace.traceId, operation.trace.traceId);
    assert.notEqual(invocation.trace.spanId, operation.trace.spanId);
    assert.equal(operation.work["synthetic"], 1);
    assert.equal(operation.release, "release-123");
    assert.equal(operation.work["sql_rows_read"], undefined);
    const count = events.length;
    await Promise.all(Array.from({ length: 40 }, () => fetch(`${origin}/ingest/observe/v1/stats/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
    await installation.application!.flush();
    assert.equal((await installation.observe.forService("stats").external("stats", {})).length, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await installation.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
