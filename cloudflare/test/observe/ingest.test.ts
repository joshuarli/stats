import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { RETENTION_MS } from "../../src/observe/core/limits.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { cleanup, ingestExternal as storeExternal, readExternalEvents } from "../../src/observe/core/store.ts";
import { receiveEvents } from "../../src/observe/ingest/failures.ts";
import { decodeBatch, encodeBatch } from "../../src/observe/ingest/codec.ts";
import { MAX_BATCH_BYTES, MAX_BATCHES_PER_WINDOW, MAX_EVENTS, PROVENANCE, type ExternalEvent, type ExternalIngest } from "../../src/observe/ingest/model.ts";
import { handleApi } from "../../src/observe/http/api.ts";
import { decodeIssues, decodeOccurrences } from "../../src/observe/client/decode.ts";
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

async function ingestExternal(db: ReturnType<typeof database>, service: string, batch: readonly ExternalEvent[], nowMs: number): Promise<ExternalIngest> {
  return storeExternal(db, service, await receiveEvents(service, batch), nowMs);
}

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

await test("the failing golden batch decodes to its canonical encoding with error last", () => {
  const failing = readFileSync(join(FIXTURES, "golden-error.json"), "utf8").trim();
  const decoded = decodeBatch(failing, options);
  assert.ok(decoded.ok);
  assert.equal(encodeBatch(decoded.batch), failing);
  const first = (JSON.parse(failing) as { events: Record<string, unknown>[] }).events[0]!;
  assert.equal(Object.keys(first).at(-1), "error");
});

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

await test("a replayed batch stores nothing twice and a conflicting event id stores nothing", async () => {
  const db = database();
  assert.deepEqual(await ingestExternal(db, manifest.service, events, manifest.nowMs), { ok: true, accepted: 2, duplicate: 0 });
  assert.equal(count(db), 2);
  assert.deepEqual(await ingestExternal(db, manifest.service, events, manifest.nowMs + 1_000), { ok: true, accepted: 0, duplicate: 2 });
  assert.equal(count(db), 2);
  const records = readExternalEvents(db, manifest.service, manifest.nowMs + 1_000);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.event), events);
  assert.ok(records.every(record => record.provenance === PROVENANCE));
  assert.deepEqual(records.map(record => record.receivedAtMs), [manifest.nowMs, manifest.nowMs]);

  const changed: ExternalEvent[] = [{ ...events[0]!, durationMs: events[0]!.durationMs + 1 }, events[1]!];
  assert.deepEqual(await ingestExternal(db, manifest.service, changed, manifest.nowMs + 2_000), { ok: false, code: "event_conflict" });
  assert.equal(count(db), 2);
});

await test("cleanup expires external events and allows their ids to be stored again", async () => {
  const db = database();
  assert.ok((await ingestExternal(db, manifest.service, [events[0]!], manifest.nowMs)).ok);
  const later = manifest.nowMs + RETENTION_MS + 1_000;
  cleanup(db, later);
  assert.equal(count(db), 0);
  assert.deepEqual(readExternalEvents(db, manifest.service, later), []);
  assert.deepEqual(await ingestExternal(db, manifest.service, [{ ...events[0]!, atMs: later }], later), { ok: true, accepted: 1, duplicate: 0 });
  assert.equal(count(db), 1);
});

await test("cleanup keeps a shared event id in a service whose row is not expired", async () => {
  const db = database();
  const eventId = "shared-event-id";
  const expired = { ...events[0]!, eventId, atMs: manifest.nowMs };
  const fresh = { ...events[1]!, eventId, atMs: manifest.nowMs + RETENTION_MS };
  assert.ok((await ingestExternal(db, "service-a", [expired], manifest.nowMs)).ok);
  assert.ok((await ingestExternal(db, "service-b", [fresh], manifest.nowMs + RETENTION_MS)).ok);
  cleanup(db, manifest.nowMs + RETENTION_MS + 1_000);
  assert.deepEqual(readExternalEvents(db, "service-a", manifest.nowMs + RETENTION_MS + 1_000), []);
  assert.equal(readExternalEvents(db, "service-b", manifest.nowMs + RETENTION_MS + 1_000).length, 1);
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

await test("application operations total in the store by operation over a half-open window, with no event cap", async () => {
  const db = database();
  const service = createObserveService(db, { now: () => manifest.nowMs, databaseBytes: () => 0 });
  const at = manifest.nowMs - 60_000;
  const event = (index: number, operation: string, outcome: string, durationMs: number, atMs = at + index) => ({ ...manifest.base, eventId: `agg-${String(index).padStart(20, "0")}`, atMs, operation, outcome, durationMs });
  const saves = Array.from({ length: 5100 }, (_, index) => event(index, "note.save", index % 100 === 0 ? "error" : "ok", index % 2 === 0 ? 10 : 30));
  for (let start = 0; start < saves.length; start += MAX_EVENTS) {
    const ingested = await ingestExternal(db, manifest.service, saves.slice(start, start + MAX_EVENTS) as unknown as ExternalEvent[], manifest.nowMs);
    assert.ok(ingested.ok);
  }
  assert.ok((await ingestExternal(db, manifest.service, [event(6000, "spool.ingest", "ok", 2), event(6001, "spool.ingest", "ok", 4, manifest.nowMs - 10_000)] as unknown as ExternalEvent[], manifest.nowMs)).ok);

  const read = await handleApi(new Request(`https://observe.test/external/operations?from=${at}&to=${manifest.nowMs - 10_000}`), "/external/operations", service, manifest.service, manifest.nowMs);
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(await read.json(), {
    fromMs: at, toMs: manifest.nowMs - 10_000,
    operations: [
      { operation: "note.save", events: 5100, failed: 51, durationMsSum: 2550 * 10 + 2550 * 30, durationMsMax: 30, firstAtMs: at, lastAtMs: at + 5099 },
      { operation: "spool.ingest", events: 1, failed: 0, durationMsSum: 2, durationMsMax: 2, firstAtMs: at + 6000, lastAtMs: at + 6000 }
    ]
  });
  const extra = await handleApi(new Request(`https://observe.test/external/operations?from=${at}&limit=5`), "/external/operations", service, manifest.service, manifest.nowMs);
  assert.equal(extra.status, 400);
  const empty = await handleApi(new Request(`https://observe.test/external/operations?from=${at}`), "/external/operations", service, "other-service", manifest.nowMs);
  assert.deepEqual((await empty.json() as { operations: unknown[] }).operations, []);
});

const FAILED_AT = manifest.nowMs - 60_000;

function failing(eventId: string, operation: string, code: string | null, outcome = "error"): Record<string, unknown> {
  return { ...manifest.base, eventId, atMs: FAILED_AT, operation, outcome, ...(code === null ? {} : { error: { code } }) };
}

function coded(eventId: string, atMs: number, code: string): ExternalEvent {
  return { ...events[0]!, eventId, atMs, outcome: "error", error: { code } };
}

async function post(service: ReturnType<typeof createObserveService>, batch: readonly Record<string, unknown>[]): Promise<Response> {
  return handleApi(request(JSON.stringify({ events: batch })), BATCH_PATH, service, manifest.service, manifest.nowMs);
}

async function read(service: ReturnType<typeof createObserveService>, path: string): Promise<unknown> {
  const response = await handleApi(new Request(`https://observe.test${path}`), path, service, manifest.service, manifest.nowMs);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function rowCount(db: ReturnType<typeof database>, table: string): number {
  return db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n;
}

await test("a failing event's error code is a bounded closed-set label that encodes canonically", () => {
  const code = `a${"z09_.-".repeat(10)}abc`;
  assert.equal(code.length, 64);
  const decoded = decodeBatch(JSON.stringify({ events: [failing("coded-1", "note.save", code)] }), options);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.batch.events[0]?.error, { code });
  const encoded = encodeBatch(decoded.batch);
  assert.ok(encoded.endsWith(`"trace":{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef"},"error":{"code":"${code}"}}]}`), encoded);
  const again = decodeBatch(encoded, options);
  assert.ok(again.ok);
  assert.equal(encodeBatch(again.batch), encoded);
});

await test("equal operation and error code group into one issue whose occurrences are the failing events", async () => {
  const db = database();
  const service = createObserveService(db, { now: () => manifest.nowMs, databaseBytes: () => 0 });
  const untraced = failing("fail-3", "note.save", "db.timeout");
  delete untraced["trace"];
  const batch = [
    failing("fail-1", "note.save", "db.timeout"),
    failing("fail-2", "note.save", "db.timeout", "timeout"),
    { ...untraced, release: "r2" },
    failing("fail-4", "note.save", "quota_exceeded"),
    failing("fail-5", "note.search", "db.timeout"),
    failing("fail-6", "note.save", null),
    { ...manifest.base, eventId: "ok-1", atMs: FAILED_AT }
  ];
  const first = await post(service, batch);
  assert.equal(first.status, 202, await first.clone().text());
  assert.deepEqual(await first.json(), { accepted: 7, duplicate: 0 });
  const replay = await post(service, batch);
  assert.deepEqual(await replay.json(), { accepted: 0, duplicate: 7 });

  const issues = decodeIssues(await read(service, "/issues"));
  assert.deepEqual(issues.items.map(issue => `${issue.operation} ${issue.name} ${issue.occurrences} ${issue.state} ${issue.frame}`).sort(), [
    "note.save db.timeout 3 open null",
    "note.save quota_exceeded 1 open null",
    "note.search db.timeout 1 open null"
  ]);
  const grouped = issues.items.find(issue => issue.operation === "note.save" && issue.name === "db.timeout")!;
  assert.equal(grouped.firstAtMs, FAILED_AT);
  assert.equal(grouped.versions, 2);

  const occurrences = decodeOccurrences(await read(service, `/issues/${grouped.fingerprint}/occurrences`));
  assert.equal(occurrences.items.length, 3);
  for (const occurrence of occurrences.items) {
    assert.deepEqual({ source: occurrence.source, name: occurrence.name, operation: occurrence.operation, message: occurrence.message, frames: occurrence.frames, atMs: occurrence.atMs }, {
      source: "application", name: "db.timeout", operation: "note.save", message: null, frames: [], atMs: FAILED_AT
    });
  }
  assert.deepEqual(occurrences.items.map(item => item.version), ["r2", "9df651c1a2b3", "9df651c1a2b3"]);
  assert.deepEqual(occurrences.items.map(item => item.traceId), [null, "0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"]);
  assert.equal(new Set(occurrences.items.map(item => item.invocationKey)).size, 3);
  assert.equal(rowCount(db, "observe_occurrences"), 5);
});

await test("a resolved application issue reopens on a later failure with its code", async () => {
  let now = manifest.nowMs;
  const db = database();
  const service = createObserveService(db, { now: () => now, databaseBytes: () => 0 });
  const [received] = await receiveEvents(manifest.service, [coded("first", FAILED_AT, "db.timeout")]);
  assert.ok(storeExternal(db, manifest.service, [received!], now).ok);
  const fingerprint = received!.failure!.fingerprint;
  assert.equal(await service.setIssueState(fingerprint, "resolved"), true);
  assert.equal((await service.issue(fingerprint))?.state, "resolved");
  now += 1_000;
  assert.ok((await ingestExternal(db, manifest.service, [coded("second", now, "db.timeout")], now)).ok);
  const reopened = await service.issue(fingerprint);
  assert.equal(reopened?.state, "open");
  assert.equal(reopened?.occurrences, 2);
});

await test("the grouping key is derived from the service, operation and code, never supplied by the client", async () => {
  const event = coded("one-event", FAILED_AT, "db.timeout");
  const [a, b, otherOperation] = await receiveEvents("tansu", [event, { ...event, eventId: "another-event" }, { ...event, operation: "note.search" }]);
  const [otherService] = await receiveEvents("niceforge", [event]);
  assert.equal(a!.failure!.fingerprint, b!.failure!.fingerprint);
  assert.match(a!.failure!.fingerprint, /^[0-9a-f]{64}$/u);
  assert.notEqual(a!.failure!.invocationKey, b!.failure!.invocationKey);
  assert.notEqual(a!.failure!.fingerprint, otherOperation!.failure!.fingerprint);
  assert.notEqual(a!.failure!.fingerprint, otherService!.failure!.fingerprint);
  assert.equal((await receiveEvents("tansu", [{ ...events[0]!, outcome: "error" }]))[0]?.failure, null);
});

await test("cleanup expires application occurrences and their issue with the event", async () => {
  const db = database();
  assert.ok((await ingestExternal(db, manifest.service, [coded("expiring", FAILED_AT, "db.timeout")], manifest.nowMs)).ok);
  assert.equal(rowCount(db, "observe_issues"), 1);
  cleanup(db, FAILED_AT + RETENTION_MS);
  assert.equal(rowCount(db, "observe_occurrences"), 0);
  assert.equal(rowCount(db, "observe_issues"), 0);
  assert.equal(count(db), 0);
});

await test("an event id stored again after its event expired adds an occurrence even while the old one awaits cleanup", async () => {
  const db = database();
  assert.ok((await ingestExternal(db, manifest.service, [coded("reused-id", FAILED_AT, "db.timeout")], manifest.nowMs)).ok);
  db.run("DELETE FROM observe_external_events");
  const later = FAILED_AT + RETENTION_MS;
  assert.deepEqual(await ingestExternal(db, manifest.service, [coded("reused-id", later, "db.timeout")], later), { ok: true, accepted: 1, duplicate: 0 });
  assert.equal(rowCount(db, "observe_occurrences"), 2);
});

await test("external-only stores keep their next retention alarm after an early cleanup", async () => {
  const db = database();
  const now = manifest.nowMs;
  const service = createObserveService(db, { now: () => now, databaseBytes: () => 0 });
  await service.ingestExternal(manifest.service, [events[0]!]);
  const maintained = service.cleanup();
  assert.ok(maintained.nextAtMs !== null);
  assert.equal(maintained.nextAtMs, Math.min(now, events[0]!.atMs) + RETENTION_MS);
  db.db.close();
});

await test("producer delivery evidence round-trips, survives storage, and never changes event identity", async () => {
  const text = readFileSync(join(FIXTURES, "golden-delivery.json"), "utf8").trim();
  const decoded = decodeBatch(text, options);
  assert.ok(decoded.ok);
  assert.equal(encodeBatch(decoded.batch), text);
  const db = database();
  try {
    const service = createObserveService(db, { now: () => manifest.nowMs, databaseBytes: () => 0 });
    assert.deepEqual(await service.ingestExternal(manifest.service, decoded.batch.events), { ok: true, accepted: 2, duplicate: 0 });
    assert.deepEqual((await service.external(manifest.service, {})).map(record => record.event.delivery?.sequence), [1, 2]);
    assert.deepEqual(await service.ingestExternal(manifest.service, events), { ok: true, accepted: 0, duplicate: 2 });
    const invalid = JSON.parse(text) as { events: { delivery: { sequence: number } }[] };
    invalid.events[0]!.delivery.sequence = 3;
    assert.equal(decodeBatch(JSON.stringify(invalid), options).ok, false);
  } finally { db.db.close(); }
});
