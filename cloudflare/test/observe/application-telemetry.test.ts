import assert from "node:assert/strict";
import test from "node:test";
import { createObserveService } from "../../src/observe/core/service.ts";
import { readApplicationSummary, readApplicationSummaryTimed, readApplicationTelemetry } from "../../src/observe/application/telemetry.ts";
import { ingestExternal } from "../../src/observe/core/store.ts";
import { receiveEvents } from "../../src/observe/ingest/failures.ts";
import type { SqlValue } from "../../src/core/sql.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";
import { handleApi } from "../../src/observe/http/api.ts";
import { database, T0, H } from "./support.ts";

const event = (index: number, service = "stats"): ExternalEvent => ({
  schemaVersion: 1, eventId: `event-${index}`, atMs: T0 - H + index,
  operation: `operation-${index % 25}`, outcome: index % 2 === 0 ? "ok" : "error",
  durationMs: 10, work: index % 3 === 0 ? { http_status: 503 } : {}, release: "release-1", service
});

await test("application telemetry summarizes the full window with bounded detail and service isolation", async () => {
  const db = database();
  try {
    for (let start = 0; start < 6000; start += 100) {
      const batch = Array.from({ length: 100 }, (_, index) => event(start + index));
      ingestExternal(db, "stats", await receiveEvents("stats", batch), T0);
    }
    ingestExternal(db, "other", await receiveEvents("other", [event(0, "other")]), T0);
    const result = readApplicationTelemetry(db, "stats", T0, { fromMs: T0 - H, toMs: T0 });
    assert.equal(result.totals?.events, 6000);
    assert.equal(result.totals?.failed, 3000);
    assert.equal(result.totals?.requests, 2000);
    assert.equal(result.totals?.status5xx, 2000);
    assert.equal(result.totals?.durationMsSum, 60_000);
    assert.equal(result.totals?.requestDurationMsSum, 20_000);
    assert.equal(result.totals?.requestDurationMsMax, 10);
    assert.equal(result.operations.length, 20);
    assert.equal(result.moreOperations, true);
    assert.deepEqual(result.operations.map(row => row.operation), Array.from({ length: 25 }, (_, index) => `operation-${index}`).sort().slice(0, 20));
    assert.equal(result.recent.length, 50);
    assert.equal(result.moreRecent, true);
    assert.equal(result.recent[0]?.eventId, "event-5999");
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.events, 0), 6000);
    assert.ok(result.buckets.length <= 121);
    assert.equal(result.provenance, "application");
    assert.equal("cpuMs" in result.totals!, false);
    const absent = readApplicationTelemetry(db, "absent", T0, {});
    assert.equal(absent.totals, null);
    assert.deepEqual(absent.buckets, []);
  } finally { db.db.close(); }
});

await test("summary reads preserve complete aggregates without loading recent event payloads", async context => {
  const db = database();
  try {
    const batch: ExternalEvent[] = [
      { ...event(0), eventId: "private-request-id", durationMs: 20, work: { http_status: 200 } },
      { ...event(1), outcome: "ok", durationMs: 120, work: {} },
      { ...event(2), outcome: "cancelled", durationMs: 10, work: {} }
    ];
    ingestExternal(db, "stats", await receiveEvents("stats", batch), T0);
    const detail = readApplicationTelemetry(db, "stats", T0, {});
    const read = db.rows.bind(db);
    const reads = context.mock.method(db, "rows", (query: string, ...parameters: SqlValue[]) => {
      assert.match(query, /^\s*SELECT\b/iu, "OpenOrange 1.0.2 sends other leading keywords through a write turn");
      return read(query, ...parameters);
    });
    const summary = readApplicationSummary(db, "stats", T0, {});
    assert.deepEqual(summary.totals, detail.totals);
    assert.deepEqual(summary.buckets, detail.buckets);
    assert.deepEqual(summary.operations, detail.operations);
    assert.equal(summary.totals?.cancelled, 1);
    assert.equal(summary.totals?.requestDurationMsSum, 20);
    assert.equal(summary.totals?.durationMsSum, 150);
    assert.equal(reads.mock.callCount(), 2);
    assert.equal("recent" in summary, false);
    assert.doesNotMatch(JSON.stringify(summary), /private-request-id/);
    const store = createObserveService(db, { now: () => T0, databaseBytes: () => 0 });
    const response = await handleApi(new Request("https://observe/external/telemetry/summary"), "/external/telemetry/summary", store, "stats", T0);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Server-Timing")!, /app-store;dur=\d+\.\d{3}, app-query;dur=\d+\.\d{3}, app-issues;dur=\d+\.\d{3}, app-read;dur=\d+\.\d{3}, app-encode;dur=\d+\.\d{3}/u);
    assert.deepEqual(await response.json(), summary);
  } finally { db.db.close(); }
});

await test("application telemetry uses a half-open window and rejects malformed HTTP filters", async () => {
  const db = database();
  try {
    const batch = [event(0), { ...event(1), atMs: T0 }];
    ingestExternal(db, "stats", await receiveEvents("stats", batch), T0);
    const result = readApplicationTelemetry(db, "stats", T0, { fromMs: T0 - H, toMs: T0 });
    assert.equal(result.totals?.events, 1);
    const store = createObserveService(db, { now: () => T0, databaseBytes: () => 0 });
    const response = await handleApi(new Request("https://observe/external/telemetry?from=1&from=2"), "/external/telemetry", store, "stats", T0);
    assert.equal(response.status, 400);
    const valid = await handleApi(new Request(`https://observe/external/telemetry?from=${T0 - H}&to=${T0}`), "/external/telemetry", store, "stats", T0);
    assert.equal(valid.status, 200);
    assert.equal((await valid.json() as { totals: { events: number } }).totals.events, 1);
  } finally { db.db.close(); }
});

await test("summary keeps HTTP status boundaries and background durations distinct", async () => {
  const db = database();
  try {
    const statuses = [99, 100, 199, 200, 299, 300, 399, 400, 499, 500, 599, 600];
    const batch = statuses.map((status, index) => ({ ...event(index), outcome: "ok", durationMs: index + 1, work: { http_status: status } }));
    ingestExternal(db, "stats", await receiveEvents("stats", batch), T0);
    const result = readApplicationSummary(db, "stats", T0, { fromMs: T0 - H, toMs: T0 });
    assert.equal(result.totals?.events, 12);
    assert.equal(result.totals?.requests, 10);
    assert.equal(result.totals?.requestDurationMsSum, 65);
    assert.equal(result.totals?.requestDurationMsMax, 11);
    assert.equal(result.totals?.durationMsSum, 78);
    assert.equal(result.totals?.durationMsMax, 12);
    assert.deepEqual([result.totals?.status2xx, result.totals?.status3xx, result.totals?.status4xx, result.totals?.status5xx], [2, 2, 2, 2]);
    assert.equal(result.totals?.failed, 0);
    assert.deepEqual(Object.keys(result.buckets[0]!).sort(), [...Object.keys(result.totals!), "atMs"].sort());
    assert.deepEqual(Object.keys(result.operations[0]!).sort(), [...Object.keys(result.totals!), "operation"].sort());
  } finally { db.db.close(); }
});

await test("summary diagnostics separate aggregate and issue reads without changing data", async context => {
  const db = database();
  try {
    ingestExternal(db, "stats", await receiveEvents("stats", [event(1)]), T0);
    const expected = readApplicationSummary(db, "stats", T0, {});
    let monotonic = 100;
    const read = db.rows.bind(db);
    context.mock.method(db, "rows", (query: string, ...parameters: SqlValue[]) => {
      monotonic += query.includes("WITH events") ? 37 : 7;
      return read(query, ...parameters);
    });
    const result = readApplicationSummaryTimed(db, "stats", T0, {}, () => monotonic);
    assert.deepEqual(result.data, expected);
    assert.deepEqual({ queryMs: result.queryMs, issuesMs: result.issuesMs, readMs: result.readMs }, { queryMs: 37, issuesMs: 7, readMs: 44 });
  } finally { db.db.close(); }
});
