import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { RETENTION_MS } from "../../src/observe/core/limits.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { cleanup, ingestExternal, readExternalEvents } from "../../src/observe/core/store.ts";
import { decodeBatch, encodeBatch } from "../../src/observe/ingest/codec.ts";
import { MAX_BATCH_BYTES, MAX_BATCHES_PER_WINDOW, MAX_EVENTS, PROVENANCE, type ExternalEvent } from "../../src/observe/ingest/model.ts";
import { handleApi } from "../../src/observe/http/api.ts";
import { database } from "./support.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/observe-ingest");
const BATCH_PATH = "/ingest/observe/v1/batches";

interface Case {
  readonly name: string;
  readonly code: string;
  readonly text?: string;
  readonly body?: unknown;
  readonly events?: readonly Record<string, unknown>[];
}

interface Manifest {
  readonly service: string;
  readonly nowMs: number;
  readonly golden: string;
  readonly base: Record<string, unknown>;
  readonly cases: readonly Case[];
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as Manifest;
const golden = readFileSync(join(FIXTURES, manifest.golden), "utf8").trim();
const options = { service: manifest.service, nowMs: manifest.nowMs };
const valid = decodeBatch(golden, options);
if (!valid.ok) throw new Error(`golden batch did not decode: ${valid.code}`);
const events = valid.batch.events;

function count(db: ReturnType<typeof database>): number {
  return db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_external_events")[0]?.n ?? 0;
}

function bodyOf(item: Case): string {
  if (item.text !== undefined) return item.text;
  if (item.body !== undefined) return JSON.stringify(item.body);
  return JSON.stringify({ events: item.events!.map(patch => ({ ...manifest.base, ...patch })) });
}

function request(body: string, headers: Record<string, string> = { "content-type": "application/json" }, query = ""): Request {
  return new Request(`https://observe.test${BATCH_PATH}${query}`, { method: "POST", headers, body });
}

await test("the golden batch decodes to its canonical encoding", () => {
  assert.equal(encodeBatch(valid.batch), golden);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    schemaVersion: 1, eventId: "01J8Z9K4Q7Y6V5X3W2T1S0R9P8", atMs: 1793966340000, operation: "note.save", outcome: "ok",
    durationMs: 42, work: { bytes: 1200, revisions: 1 }, release: "9df651c1a2b3", service: "tansu", instance: "tansu-1", host: "lisa",
    trace: { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" }
  });
  assert.deepEqual(events[1]?.work, { bytes: 512, results: 3 });
});

await test("every malformed fixture is rejected whole with a stable code", () => {
  for (const item of manifest.cases) {
    const result = decodeBatch(bodyOf(item), options);
    assert.equal(result.ok, false, item.name);
    if (!result.ok) assert.equal(result.code, item.code, item.name);
  }
});

await test("a batch may carry at most 128 events, and every label is bounded", () => {
  const atLimit = Array.from({ length: MAX_EVENTS }, (_, index) => ({ ...manifest.base, eventId: `event-${index.toString().padStart(3, "0")}` }));
  assert.equal(decodeBatch(JSON.stringify({ events: atLimit }), options).ok, true);
  const over = decodeBatch(JSON.stringify({ events: [...atLimit, { ...manifest.base, eventId: "event-over" }] }), options);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, "too_many_events");
  const longWork = decodeBatch(JSON.stringify({ events: [{ ...manifest.base, work: { ["a".repeat(33)]: 1 } }] }), options);
  assert.equal(longWork.ok, false);
  if (!longWork.ok) assert.equal(longWork.code, "invalid_work");
});

await test("a replayed batch stores nothing twice and a conflicting event id stores nothing", () => {
  const db = database();
  assert.deepEqual(ingestExternal(db, manifest.service, events, manifest.nowMs), { ok: true, accepted: 2, duplicate: 0 });
  assert.equal(count(db), 2);
  assert.deepEqual(ingestExternal(db, manifest.service, events, manifest.nowMs + 1_000), { ok: true, accepted: 0, duplicate: 2 });
  assert.equal(count(db), 2);
  const records = readExternalEvents(db, manifest.service, manifest.nowMs + 1_000);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.event), events);
  assert.ok(records.every(record => record.provenance === PROVENANCE));
  assert.deepEqual(records.map(record => record.receivedAtMs), [manifest.nowMs, manifest.nowMs]);

  const changed: ExternalEvent[] = [{ ...events[0]!, durationMs: events[0]!.durationMs + 1 }, events[1]!];
  assert.deepEqual(ingestExternal(db, manifest.service, changed, manifest.nowMs + 2_000), { ok: false, code: "event_conflict" });
  assert.equal(count(db), 2);
});

await test("cleanup expires external events and allows their ids to be stored again", () => {
  const db = database();
  assert.ok(ingestExternal(db, manifest.service, [events[0]!], manifest.nowMs).ok);
  const later = manifest.nowMs + RETENTION_MS + 1_000;
  cleanup(db, later);
  assert.equal(count(db), 0);
  assert.deepEqual(readExternalEvents(db, manifest.service, later), []);
  assert.deepEqual(ingestExternal(db, manifest.service, [{ ...events[0]!, atMs: later }], later), { ok: true, accepted: 1, duplicate: 0 });
  assert.equal(count(db), 1);
});

await test("the ingest route caps the body before parse, deduplicates, and authenticates nothing itself", async () => {
  const db = database();
  const service = createObserveService(db, { now: () => manifest.nowMs, databaseBytes: () => 0 });
  const first = await handleApi(request(golden), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(first.status, 202, await first.clone().text());
  assert.deepEqual(await first.json(), { accepted: 2, duplicate: 0 });
  const replay = await handleApi(request(golden), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), { accepted: 0, duplicate: 2 });

  const read = await handleApi(new Request(`https://observe.test/external?from=${manifest.nowMs - 60_000}&to=${manifest.nowMs}`), "/external", service, manifest.service, manifest.nowMs);
  assert.equal(read.status, 200);
  const body = await read.json() as { events: { event: ExternalEvent }[] };
  assert.deepEqual(body.events.map(item => item.event), events);

  const oversized = await handleApi(request("x".repeat(MAX_BATCH_BYTES + 1)), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json() as { error: { code: string } }).error.code, "too_large");

  const media = await handleApi(request(golden, { "content-type": "text/plain" }), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(media.status, 415);
  const query = await handleApi(request(golden, undefined, "?extra=1"), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(query.status, 400);
  const malformed = await handleApi(request("{"), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "invalid_json");
});

await test("the ingest route rate-limits each service independently", async () => {
  const db = database();
  const service = createObserveService(db, { now: () => manifest.nowMs, databaseBytes: () => 0 });
  const event = { ...manifest.base, atMs: manifest.nowMs - 1_000, eventId: "rate-event-000000000001" };
  const body = JSON.stringify({ events: [event] });
  for (let index = 0; index < MAX_BATCHES_PER_WINDOW; index += 1) {
    const response = await handleApi(request(body), BATCH_PATH, service, manifest.service, manifest.nowMs);
    assert.ok(response.status === 202 || response.status === 200, `${index}: ${response.status}`);
  }
  const limited = await handleApi(request(body), BATCH_PATH, service, manifest.service, manifest.nowMs);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { error: { code: string } }).error.code, "rate_limited");
  const otherEvent = { ...event, service: "usr-memories", eventId: "rate-other-00000000001" };
  const other = await handleApi(request(JSON.stringify({ events: [otherEvent] })), BATCH_PATH, service, "usr-memories", manifest.nowMs);
  assert.equal(other.status, 202);
  assert.deepEqual(await other.json(), { accepted: 1, duplicate: 0 });
});
