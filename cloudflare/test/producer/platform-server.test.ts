import assert from "node:assert/strict";
import { test } from "node:test";
import { createProducer } from "../../../packages/producer/src/index.ts";
import { createBridgeServer, MAX_OTLP_BYTES } from "../../../packages/platform-bridge/src/server.ts";
import { batch, policy } from "./platform-support.ts";
const token = "x".repeat(48);
await test("OTLP receiver is authenticated, bounded and independent of downstream availability", async () => {
  const producer = createProducer({ endpoint: "http://127.0.0.1:9", service: "stats-platform", token: "unused-test-token", release: "bridge-test", maxRetries: 0, fetch: async () => new Response(null, { status: 503 }), flushIntervalMs: 60000 });
  const bridge = createBridgeServer({ producer, policy, token });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  const address = bridge.server.address(); assert.ok(address !== null && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, authorization = `Bearer ${token}`, contentType = "application/json") => fetch(`${base}/v1/traces`, { method: "POST", headers: { authorization, "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    assert.equal((await post(batch(), "")).status, 403);
    assert.equal((await post(batch(), `Bearer ${"y".repeat(48)}`)).status, 403);
    assert.equal((await post(batch(), `Bearer ${token}`, "text/plain")).status, 415);
    assert.equal((await post("x".repeat(MAX_OTLP_BYTES + 1))).status, 413);
    const oversized = batch(); oversized.resourceSpans[0]!.scopeSpans[0]!.spans = Array.from({ length: 257 }, () => oversized.resourceSpans[0]!.scopeSpans[0]!.spans[0]!);
    assert.equal((await post(oversized)).status, 400);
    assert.equal(bridge.counters().admitted, 0);
    assert.equal((await post(batch())).status, 200);
    await producer.flush();
    assert.equal(producer.stats().dropped, 1);
    assert.equal(bridge.counters().admitted, 1);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.doesNotMatch(await health.text(), new RegExp(token, "u"));
  } finally { bridge.server.closeAllConnections(); await new Promise<void>(done => bridge.server.close(() => done())); await producer.shutdown(); }
});
await test("slow downstream delivery never holds the OTLP response and the queue stays bounded", async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(done => { release = done; });
  const producer = createProducer({ endpoint: "http://127.0.0.1:9", service: "stats-platform", token: "unused-test-token", release: "bridge-test", queueLimit: 128, batchSize: 64, maxRetries: 0, fetch: async (_url, init) => { await blocked; return Response.json({ accepted: (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { events: unknown[] }).events.length, duplicate: 0 }, { status: 202 }); } });
  const bridge = createBridgeServer({ producer, policy, token });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  const address = bridge.server.address(); assert.ok(address !== null && typeof address !== "string");
  try {
    const value = batch(), span = value.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    value.resourceSpans[0]!.scopeSpans[0]!.spans = Array.from({ length: 256 }, (_, index) => ({ ...span, spanId: (index + 1).toString(16).padStart(16, "0") }));
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.equal(bridge.counters().admitted, 256);
    assert.ok(producer.stats().queued <= 128);
    assert.ok(producer.stats().dropped > 0);
  } finally { release!(); bridge.server.closeAllConnections(); await new Promise<void>(done => bridge.server.close(() => done())); await producer.shutdown(); }
});
