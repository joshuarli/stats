import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferedApplicationPost } from "../../src/observe/application/buffered.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";
import { createBindingProducer } from "../../../packages/producer/src/index.ts";

const event = (id: number): ExternalEvent => ({ schemaVersion: 1, service: "stats", release: "binding-proof", eventId: `binding-${id}`, atMs: Date.now(), operation: "http.get.services", outcome: "ok", durationMs: 2, work: { store_us: 1000 } });
const ack = (events: readonly unknown[]) => Response.json({ accepted: events.length, duplicate: 0 });

await test("private self-observation batches a burst and preserves every event without credentials", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const received: ExternalEvent[][] = [];
  const binding = { fetch: async (request: Request) => {
    assert.equal(request.url, "https://observe/stats/ingest/observe/v1/batches");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.signal.aborted, false);
    const body = await request.json() as { events: ExternalEvent[] };
    received.push(body.events);
    return ack(body.events);
  } };
  const post = bufferedApplicationPost(binding, "binding-proof");
  assert.equal(bufferedApplicationPost(binding, "binding-proof"), post);
  const events = Array.from({ length: 16 }, (_, index) => event(index));
  const pending = events.map(entry => post({ events: [entry] }));
  assert.equal(new Set(pending).size, 1);
  assert.equal(received.length, 0);
  context.mock.timers.tick(1000);
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.equal(received.length, 1);
  assert.deepEqual(received.flat().map(({ delivery: _delivery, ...entry }) => entry), events);
  const next = post({ events: [event(17)] });
  context.mock.timers.tick(1000);
  assert.equal(await next, true);
  assert.equal(received.length, 2);
});

await test("a stalled private receiver bounds queued work and reports loss in delivery metadata", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const received: ExternalEvent[][] = [];
  const post = bufferedApplicationPost({ fetch: async request => {
    const body = await request.json() as { events: ExternalEvent[] };
    received.push(body.events);
    await blocked;
    return ack(body.events);
  } }, "binding-proof");
  const pending = Array.from({ length: 300 }, (_, index) => post({ events: [event(index)] }));
  context.mock.timers.tick(1000);
  unblock();
  assert.ok((await Promise.all(pending)).some(result => !result));
  assert.equal(received.flat().length, 192);
  assert.equal(received.at(-1)!.at(-1)!.delivery!.dropped, 108);
  assert.ok(received.every(batch => batch.length <= 64));
});

await test("binding producers retry boundedly, accept duplicate acknowledgments, and deny auth failures", async () => {
  let calls = 0;
  const producer = createBindingProducer({ service: "stats", release: "binding-proof", maxRetries: 1, sleep: () => Promise.resolve(), postBatch: async (_body, signal) => {
    assert.equal(signal.aborted, false);
    calls++;
    return calls === 1 ? new Response(null, { status: 503 }) : Response.json({ accepted: 0, duplicate: 1 });
  } });
  producer.record(event(1));
  await producer.shutdown();
  assert.equal(calls, 2);
  assert.equal(producer.stats().duplicates, 1);
  const denied = createBindingProducer({ service: "stats", release: "binding-proof", postBatch: () => Promise.resolve(new Response(null, { status: 403 })) });
  denied.record(event(2));
  await denied.shutdown();
  assert.equal(denied.stats().dropped, 1);
  assert.equal(denied.stats().retries, 0);
  assert.equal(denied.stats().lastError, "http_403");
});

await test("delivery loss logs bounded SDK diagnostics without receiver bodies or credentials", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = context.mock.method(console, "error", () => {});
  const post = bufferedApplicationPost({ fetch: () => Promise.resolve(new Response("private receiver detail", { status: 403 })) }, "binding-proof");
  const pending = Array.from({ length: 16 }, (_, index) => post({ events: [event(index)] }));
  context.mock.timers.tick(1000);
  assert.ok((await Promise.all(pending)).every(result => !result));
  assert.equal(logs.mock.calls.length, 1);
  assert.deepEqual(JSON.parse(logs.mock.calls[0]!.arguments[0] as string), { event: "application_delivery_loss", dropped: 16, queued: 0, retries: 0, lastError: "http_403" });
  assert.doesNotMatch(JSON.stringify(logs.mock.calls), /private receiver detail/u);
});

await test("events arriving during a flush keep their own background delivery lifetime", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: ExternalEvent[][] = [];
  const releases: (() => void)[] = [];
  const post = bufferedApplicationPost({ fetch: async request => {
    const body = await request.json() as { events: ExternalEvent[] };
    batches.push(body.events);
    await new Promise<void>(resolve => { releases.push(resolve); });
    return ack(body.events);
  } }, "binding-proof");
  const first = post({ events: [event(1)] });
  context.mock.timers.tick(1000);
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.equal(batches.length, 1);
  const later = post({ events: [event(2)] });
  assert.notEqual(later, first);
  let laterFinished = false;
  void later.then(() => { laterFinished = true; });
  context.mock.timers.tick(1000);
  releases.shift()!();
  assert.equal(await first, true);
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.equal(batches.length, 2);
  assert.equal(laterFinished, false);
  assert.deepEqual(batches.map(batch => batch.map(entry => entry.eventId)), [["binding-1"], ["binding-2"]]);
  releases.shift()!();
  assert.equal(await later, true);
});
