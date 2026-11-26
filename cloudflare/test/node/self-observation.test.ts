import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { openAssets } from "../../src/node/assets.ts";
import { openNodeInstallation } from "../../src/node/installation.ts";
import { createStatsServer, observeHandler } from "../../src/node/server.ts";
import { OBSERVE_SERVICE, rebasedBatch } from "../support/observe-ingest.ts";
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
    await response.arrayBuffer();
    await new Promise<void>(resolve => setImmediate(resolve));
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
    const invalidTrace = await fetch(`${origin}/api/v1/hosts/${created.value.hostId}/history?range=24h&kind=summary`, { headers: { ...headers, traceparent: `00-${"0".repeat(32)}-${"b".repeat(16)}-01` } });
    await invalidTrace.arrayBuffer();
    await installation.application!.flush();
    const traces = (await installation.observe.forService("stats").external("stats", {})).map(row => row.event).filter(event => event.operation === "host.history").map(event => event.trace!.traceId);
    assert.ok(traces.some(trace => /^[a-f0-9]{32}$/u.test(trace) && trace !== "0".repeat(32) && trace !== "a".repeat(32)));
    await assert.rejects(installation.application!.capture(new Request("https://stats/api/v1/hosts"), async () => {
      installation.application!.operations.invocation();
      throw new Error("private failure detail");
    }), /private failure detail/u);
    await installation.application!.flush();
    const failures = (await installation.observe.forService("stats").external("stats", {})).map(row => row.event).filter(event => event.operation === "installation.request" && event.outcome === "error");
    assert.ok(failures.length > 0);
    assert.doesNotMatch(JSON.stringify(failures), /private failure detail/u);
    const service = await installation.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: OBSERVE_SERVICE, hostIds: [created.value.hostId] }) }));
    assert.equal(service.status, 201);
    const credentials = await service.json() as { ingestToken: string };
    await installation.application!.flush();
    const count = (await installation.observe.forService("stats").external("stats", {})).length;
    const batch = rebasedBatch(Date.now()).text;
    const replies = await Promise.all(Array.from({ length: 40 }, () => fetch(`${origin}/ingest/observe/v1/${OBSERVE_SERVICE}/batches`, { method: "POST", headers: { authorization: `Bearer ${credentials.ingestToken}`, "content-type": "application/json" }, body: batch })));
    assert.ok(replies.every(reply => reply.status === 200 || reply.status === 202));
    await installation.application!.flush();
    assert.equal((await installation.observe.forService("stats").external("stats", {})).length, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await installation.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("Node captures response completion separately and accepts bounded same-origin browser journeys", async () => {
  const directory = scratchDirectory("node-http-observation");
  const installation = openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: "[]", release: "release-123" });
  let finishBody: (() => void) | undefined;
  let reportCancel: (() => void) | undefined;
  const cancelled = new Promise<void>(resolve => { reportCancel = resolve; });
  const assets = () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      finishBody = () => { finishBody = undefined; controller.enqueue(new TextEncoder().encode("last")); controller.close(); };
    },
    cancel() { finishBody = undefined; reportCancel?.(); }
  })));
  const server = createStatsServer({ installation: request => installation.core.fetch(request), observe: observeHandler(installation), assets, transport: "tcp", application: installation.application });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { "tailscale-user-login": "owner@example.com" };
  try {
    const response = await fetch(`${origin}/`, { headers });
    await installation.application!.flush();
    let events = (await installation.observe.forService("stats").external("stats", {})).map(row => row.event);
    assert.ok(events.some(event => event.operation === "http.get.dashboard"));
    assert.ok(!events.some(event => event.operation === "http.response.body"));
    finishBody!();
    assert.equal(await response.text(), "firstlast");
    await new Promise<void>(resolve => setImmediate(resolve));
    await installation.application!.flush();
    events = (await installation.observe.forService("stats").external("stats", {})).map(row => row.event);
    assert.ok(events.some(event => event.operation === "http.response.body" && event.outcome === "ok"));
    const journey = { schemaVersion: 1, source: "navigation", range: "1h", cache: false, outcome: "ok", startedAtMs: Date.now(), durationMs: 5, asset: "app", dropped: 0, trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) }, work: { fetch_us: 100 } };
    const post = (body: string, extra: Record<string, string> = {}) => fetch(`${origin}/api/v1/ui-journeys`, { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body });
    assert.equal((await post(JSON.stringify(journey))).status, 202);
    assert.equal((await post(JSON.stringify(journey), { origin: "https://other.example" })).status, 403);
    assert.equal((await post(JSON.stringify({ ...journey, extra: "secret" }))).status, 400);
    assert.equal((await post("x".repeat(4097))).status, 413);
    await installation.application!.flush();
    assert.ok((await installation.observe.forService("stats").external("stats", {})).some(row => row.event.operation === "ui.navigation.1h.read"));
    const interrupted = await fetch(`${origin}/`, { headers });
    await interrupted.body!.cancel();
    await cancelled;
    await installation.application!.flush();
    assert.ok((await installation.observe.forService("stats").external("stats", {})).some(row => row.event.operation === "http.response.body" && row.event.outcome === "cancelled"));
  } finally {
    finishBody?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await installation.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("Node application delivery stays bounded and never blocks a request when its store stalls", async () => {
  const { NodeApplicationEvents } = await import("../../src/node/application.ts");
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const batches: number[][] = [];
  const observations = { forService: () => ({ ingestExternal: async (_service: string, events: readonly import("../../src/observe/ingest/model.ts").ExternalEvent[]) => {
    await gate;
    batches.push(events.map(event => event.delivery!.sequence));
    return { ok: true, accepted: events.length, duplicate: 0 };
  } }) };
  const application = new NodeApplicationEvents(observations as unknown as import("../../src/node/observations.ts").NodeObservations, "release-123");
  try {
    await Promise.all(Array.from({ length: 300 }, () => application.capture(new Request("https://stats/"), async () => new Response("ok"))));
    await new Promise<void>(resolve => setImmediate(resolve));
    const stats = application.stats();
    assert.equal(stats.queueHigh, 128);
    assert.ok(stats.dropped > 0);
    assert.ok(stats.queued <= 128);
    release?.();
    await application.flush();
    assert.ok(batches.every(batch => batch.length <= 64));
    assert.deepEqual(batches.flat(), [...Array.from({ length: 64 }, (_, index) => index + 1), ...Array.from({ length: 128 }, (_, index) => index + 173)]);
  } finally {
    release?.();
    await application.shutdown();
  }
});
