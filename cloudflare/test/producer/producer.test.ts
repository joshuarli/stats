import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createProducer, type ProducerConfig } from "../../../packages/producer/src/index.ts";
import { decodeBatch, encodeBatch } from "../../src/observe/ingest/codec.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/observe-ingest");
const SERVICE = "tansu";

interface Received {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

interface Served {
  readonly endpoint: string;
  readonly received: Received[];
  close(): Promise<void>;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function serve(handler: (request: Received, index: number, response: ServerResponse) => void): Promise<Served> {
  const received: Received[] = [];
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const entry = { url: incoming.url ?? "", headers: incoming.headers, body };
      received.push(entry);
      handler(entry, received.length - 1, outgoing);
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>(resolveClose => { server.closeAllConnections(); server.close(() => resolveClose()); })
  };
}

function configure(endpoint: string, overrides: Partial<ProducerConfig> = {}): ProducerConfig {
  return {
    endpoint,
    service: SERVICE,
    token: "ingest-token",
    release: "9df651c1a2b3",
    flushIntervalMs: 60_000,
    ...overrides
  };
}

const noSleep = () => Promise.resolve();

await test("an unconfigured producer is a no-op with no network activity", async () => {
  const producer = createProducer();
  producer.record({ operation: "note.save", outcome: "ok", durationMs: 1 });
  await producer.flush();
  await producer.shutdown();
  assert.deepEqual(producer.stats(), { queued: 0, dropped: 0, sent: 0, duplicates: 0, batches: 0, retries: 0, lastError: null });
  assert.equal(createProducer({ endpoint: "", service: "", token: "", release: "" }).stats().dropped, 0);
});

await test("the producer encodes the golden frame exactly and accepts a duplicate acknowledgment", async () => {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { nowMs: number };
  const golden = readFileSync(join(FIXTURES, "golden.json"), "utf8").trim();
  const decoded = decodeBatch(golden, { service: SERVICE, nowMs: manifest.nowMs });
  assert.ok(decoded.ok);
  const server = await serve((request, _index, response) => {
    assert.equal(request.url, `/ingest/observe/v1/${SERVICE}/batches`);
    assert.equal(request.headers.authorization, "Bearer ingest-token");
    assert.equal(request.body, golden);
    json(response, { accepted: 0, duplicate: 2 });
  });
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 2 }));
    for (const event of decoded.batch.events) {
      producer.record({
        operation: event.operation,
        outcome: event.outcome,
        durationMs: event.durationMs,
        work: event.work,
        eventId: event.eventId,
        atMs: event.atMs,
        ...(event.instance === undefined ? {} : { instance: event.instance }),
        ...(event.host === undefined ? {} : { host: event.host }),
        ...(event.trace === undefined ? {} : { trace: event.trace })
      });
    }
    await producer.flush();
    assert.equal(server.received.length, 1);
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 0, sent: 0, duplicates: 2, batches: 1, retries: 0, lastError: null });
    assert.equal(encodeBatch(decoded.batch), golden);
  } finally {
    await server.close();
  }
});

await test("a 401 retries once when the token provider has rotated", async () => {
  let token = "old-token";
  const server = await serve((request, index, response) => {
    if (index === 0) {
      assert.equal(request.headers.authorization, "Bearer old-token");
      token = "new-token";
      json(response, { error: { code: "unauthorized", message: "rotated" } }, 401);
      return;
    }
    assert.equal(request.headers.authorization, "Bearer new-token");
    json(response, { accepted: 1, duplicate: 0 });
  });
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 1, token: () => token, maxRetries: 2, backoffBaseMs: 1, sleep: noSleep }));
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 5, work: { bytes: 1 } });
    await producer.flush();
    assert.equal(server.received.length, 2);
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 0, sent: 1, duplicates: 0, batches: 1, retries: 1, lastError: null });
  } finally {
    await server.close();
  }
});

await test("retries use exponential backoff with jitter and stop on success", async () => {
  const delays: number[] = [];
  const server = await serve((_request, index, response) => {
    if (index < 2) return json(response, { error: { code: "unavailable", message: "retry" } }, 503);
    json(response, { accepted: 1, duplicate: 0 });
  });
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 1, maxRetries: 3, backoffBaseMs: 10, random: () => 0, sleep: async ms => { delays.push(ms); } }));
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 5, work: { bytes: 1 } });
    await producer.flush();
    assert.deepEqual(delays, [5, 10]);
    assert.equal(server.received.length, 3);
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 0, sent: 1, duplicates: 0, batches: 1, retries: 2, lastError: null });
  } finally {
    await server.close();
  }
});

await test("a malformed success body is retried a bounded number of times and then dropped", async () => {
  const server = await serve((_request, _index, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not json");
  });
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 1, maxRetries: 1, backoffBaseMs: 1, sleep: noSleep }));
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 5, work: { bytes: 1 } });
    await producer.flush();
    assert.equal(server.received.length, 2);
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 1, sent: 0, duplicates: 0, batches: 0, retries: 1, lastError: "malformed_response" });
  } finally {
    await server.close();
  }
});

await test("a permanent rejection is not retried, including an oversized body", async () => {
  const server = await serve((_request, _index, response) => json(response, { error: { code: "too_large", message: "too large" } }, 413));
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 1, maxRetries: 5, backoffBaseMs: 1, sleep: noSleep }));
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 5, work: { bytes: 1 } });
    await producer.flush();
    assert.equal(server.received.length, 1);
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 1, sent: 0, duplicates: 0, batches: 0, retries: 0, lastError: "http_413" });
  } finally {
    await server.close();
  }
});

await test("a timeout is dropped after the retry budget", async () => {
  const server = await serve(() => {});
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 1, timeoutMs: 10, maxRetries: 0, backoffBaseMs: 1, sleep: noSleep }));
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 5, work: { bytes: 1 } });
    await producer.flush();
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 1, sent: 0, duplicates: 0, batches: 0, retries: 0, lastError: "timeout" });
  } finally {
    await server.close();
  }
});

await test("queue overflow drops the oldest event and keeps the newest", async () => {
  const server = await serve((_request, _index, response) => json(response, { accepted: 2, duplicate: 0 }));
  try {
    const producer = createProducer(configure(server.endpoint, { queueLimit: 2, batchSize: 128, now: () => 1_793_966_340_000 }));
    let sequence = 0;
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 1, work: { bytes: 1 }, eventId: `event-${sequence++}` });
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 1, work: { bytes: 2 }, eventId: `event-${sequence++}` });
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 1, work: { bytes: 3 }, eventId: `event-${sequence++}` });
    assert.equal(producer.stats().dropped, 1);
    assert.equal(producer.stats().queued, 2);
    await producer.flush();
    const decoded = decodeBatch(server.received[0]!.body, { service: SERVICE, nowMs: 1_793_966_400_000 });
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.batch.events.map(event => event.work["bytes"]), [2, 3]);
  } finally {
    await server.close();
  }
});

await test("a batch never exceeds 128 events, and shutdown flushes the queue", async () => {
  const server = await serve((_request, _index, response) => json(response, { accepted: 0, duplicate: 0 }));
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 128, now: () => 1_793_966_340_000 }));
    for (let index = 0; index < 130; index += 1) producer.record({ operation: "note.save", outcome: "ok", durationMs: 1, work: { bytes: index }, eventId: `event-${index.toString().padStart(3, "0")}` });
    await producer.shutdown();
    assert.equal(server.received.length, 2);
    for (const request of server.received) {
      const decoded = decodeBatch(request.body, { service: SERVICE, nowMs: 1_793_966_400_000 });
      assert.ok(decoded.ok);
      assert.ok(decoded.batch.events.length <= 128);
    }
    assert.equal(producer.stats().queued, 0);
    producer.record({ operation: "note.save", outcome: "ok", durationMs: 1, work: { bytes: 1 } });
    assert.equal(producer.stats().dropped, 1);
    assert.equal(producer.stats().lastError, "closed");
  } finally {
    await server.close();
  }
});

await test("an invalid event is dropped without a request", async () => {
  const server = await serve((_request, _index, response) => json(response, { accepted: 1, duplicate: 0 }));
  try {
    const producer = createProducer(configure(server.endpoint, { batchSize: 1 }));
    producer.record({ operation: "Note.Save", outcome: "ok", durationMs: 1, work: { bytes: 1 } });
    await producer.flush();
    assert.equal(server.received.length, 0);
    assert.deepEqual(producer.stats(), { queued: 0, dropped: 1, sent: 0, duplicates: 0, batches: 0, retries: 0, lastError: "invalid_event" });
  } finally {
    await server.close();
  }
});
