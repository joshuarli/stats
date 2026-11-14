import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBatch } from "../../src/observe/ingest/codec.ts";
import { applicationEventOperations, toApplicationEvent, APPLICATION_EVENTS_SERVICE } from "../../src/observe/application/sink.ts";
import type { OperationSummary } from "../../src/observe/producer/channel.ts";

const NOW = 1_793_510_415_000;
const OPTIONS = { post: () => Promise.resolve(true), now: () => NOW, release: "stats-eval-1234567" } as const;

const INGEST: OperationSummary = {
  operation: "host.ingest",
  synthetic: false,
  rows: { read: 3, written: 5, statements: 4 },
  durationMs: 17,
  work: { received: 10, persisted: 7, duplicate: 2, rejected: { invalid_sample: 1, too_old: 0, conflict: 0 }, inputBytes: 900 }
} as OperationSummary;

const HISTORY: OperationSummary = {
  operation: "host.history",
  synthetic: false,
  rows: { read: 0, written: 0, statements: 1 },
  workloadClass: "24h:cpu",
  work: { points: 60, cells: 120, outputBytes: 4000, cache: "rebuilt" }
} as OperationSummary;

const POLL: OperationSummary = { operation: "deployments.poll", synthetic: false, rows: { read: 1, written: 1, statements: 2 } } as OperationSummary;

await test("every operation summary becomes an application event that satisfies the ingestion contract", () => {
  for (const summary of [INGEST, HISTORY, POLL]) {
    const event = toApplicationEvent(summary, OPTIONS);
    const decoded = decodeBatch(JSON.stringify({ events: [event] }), { service: APPLICATION_EVENTS_SERVICE, nowMs: NOW });
    assert.equal(decoded.ok, true, `${summary.operation}: ${decoded.ok ? "" : decoded.message}`);
    if (decoded.ok) {
      const [parsed] = decoded.batch.events;
      assert.equal(parsed!.operation, summary.operation);
      assert.equal(parsed!.service, APPLICATION_EVENTS_SERVICE);
      assert.equal(parsed!.release, "stats-eval-1234567");
      assert.equal(parsed!.durationMs, summary.durationMs ?? 0);
    }
  }
});

await test("the sink posts one batch per operation and never throws when ingest fails", async () => {
  const posted: unknown[] = [];
  const failing = applicationEventOperations({ post: async body => { posted.push(body); return false; }, now: () => NOW, release: "stats-eval-1234567" });
  failing.operation(INGEST);
  failing.invocation();
  failing.operation(POLL);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.length, 2);
  const strict = decodeBatch(JSON.stringify(posted[0]), { service: APPLICATION_EVENTS_SERVICE, nowMs: NOW });
  assert.equal(strict.ok, true);
  const throwing = applicationEventOperations({ post: () => Promise.reject(new Error("observe down")), now: () => NOW, release: "stats-eval-1234567" });
  throwing.operation(POLL);
  await new Promise(resolve => setImmediate(resolve));
});

await test("work fields are logical counts with snake_case names and stay within the contract", () => {
  const event = toApplicationEvent(INGEST, OPTIONS);
  assert.deepEqual(event.work, {
    sql_rows_read: 3,
    sql_rows_written: 5,
    sql_statements: 4,
    received: 10,
    persisted: 7,
    duplicate: 2,
    input_bytes: 900,
    rejected_invalid_sample: 1,
    rejected_too_old: 0,
    rejected_conflict: 0
  });
  const wide = toApplicationEvent({ ...INGEST, work: Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`field${index}`, index])) } as unknown as OperationSummary, OPTIONS);
  assert.ok(Object.keys(wide.work).length <= 16);
});

await test("reported errors reach application issues and resolve uploaded source maps", async () => {
  const { default: diagnostics } = await import("node:diagnostics_channel");
  const { encode } = await import("@jridgewell/sourcemap-codec");
  const { OBSERVE_CHANNEL } = await import("../../src/observe/producer/channel.ts");
  const { reportError } = await import("../../src/observe/producer/report.ts");
  const { applicationEventErrorReporter } = await import("../../src/observe/application/sink.ts");
  const { createObserveService } = await import("../../src/observe/core/service.ts");
  const { handleApi } = await import("../../src/observe/http/api.ts");
  const { database } = await import("./support.ts");
  const db = database();
  const service = createObserveService(db, { now: () => NOW, databaseBytes: () => 0 });
  const pending: Promise<unknown>[] = [];
  const posted: unknown[] = [];
  const subscriber = applicationEventErrorReporter({ ...OPTIONS, release: "v1", waitUntil: promise => pending.push(promise), post: async body => {
    posted.push(body);
    const response = await handleApi(new Request("https://observe.test/ingest/observe/v1/batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "/ingest/observe/v1/batches", service, "stats", NOW);
    return response.status === 202;
  } });
  const channel = diagnostics.channel(OBSERVE_CHANNEL);
  channel.subscribe(subscriber);
  try {
    await service.artifact({ version: "v1", file: "index.js", map: JSON.stringify({ version: 3, file: "index.js", sources: ["src/source.ts"], names: ["original"], mappings: encode([[], [], [[4, 0, 57, 10, 0]]]) }) });
    const error = new Error("token=secret");
    error.stack = `Error: token=secret\n    at run (https://example.test/index.js?token=secret:3:5)\n${Array.from({ length: 40 }, () => "    at run (index.js:3:5)").join("\n")}`;
    reportError("deployments.api", error);
    await Promise.all(pending);
    assert.equal(posted.length, 1);
    const text = JSON.stringify(posted[0]);
    assert.ok(!text.includes("secret"));
    const decoded = decodeBatch(text, { service: "stats", nowMs: NOW });
    assert.ok(decoded.ok);
    assert.equal(decoded.batch.events[0]!.diagnostics!.frames.length, 31);
    assert.equal((await service.external("stats", {}))[0]!.event.outcome, "error");
    const response = await handleApi(new Request("https://observe.test/api/observe/stats/issues"), "/issues", service, "stats", NOW);
    assert.equal(response.status, 200);
    const issues = await response.json() as { items: { fingerprint: string; frame: string }[] };
    assert.equal(issues.items[0]!.frame, "original (src/source.ts:58)");
    const occurrences = await service.occurrences(issues.items[0]!.fingerprint, {});
    assert.equal(occurrences.items[0]!.frames[0]!.original?.file, "src/source.ts");
  } finally {
    channel.unsubscribe(subscriber);
    db.db.close();
  }
});

await test("the TypeScript producer bounds diagnostics before encoding", async () => {
  const { createProducer } = await import("../../../packages/producer/src/index.ts");
  let sent: { events: { diagnostics: { name: string; message: string; frames: string[] } }[] } | undefined;
  const producer = createProducer({ endpoint: "https://example.test", service: "stats", token: "test", release: "v1", now: () => NOW, newEventId: () => "event-1", fetch: async (_url, init) => {
    if (typeof init?.body !== "string") throw new TypeError("expected JSON body");
    sent = JSON.parse(init.body) as typeof sent;
    return Response.json({ accepted: 1, duplicate: 0 });
  } });
  producer.record({ operation: "deployments.api", outcome: "error", durationMs: 1, errorCode: "deployments.api", diagnostics: { version: 1, name: "x".repeat(200), message: "m".repeat(600), frames: Array.from({ length: 40 }, () => "f".repeat(600)) } });
  await producer.flush();
  const diagnostic = sent!.events[0]!.diagnostics;
  assert.equal(diagnostic.name.length, 128);
  assert.equal(diagnostic.message.length, 512);
  assert.equal(diagnostic.frames.length, 32);
  assert.ok(diagnostic.frames.every(frame => frame.length === 512));
  await producer.shutdown();
});
