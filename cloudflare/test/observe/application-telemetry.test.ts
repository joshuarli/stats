import assert from "node:assert/strict";
import test from "node:test";
import { createObserveService } from "../../src/observe/core/service.ts";
import { readApplicationTelemetry } from "../../src/observe/application/telemetry.ts";
import { ingestExternal } from "../../src/observe/core/store.ts";
import { receiveEvents } from "../../src/observe/ingest/failures.ts";
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
      await ingestExternal(db, "stats", await receiveEvents("stats", batch), T0);
    }
    await ingestExternal(db, "other", await receiveEvents("other", [event(0, "other")]), T0);
    const result = readApplicationTelemetry(db, "stats", T0, { fromMs: T0 - H, toMs: T0 });
    assert.equal(result.totals?.events, 6000);
    assert.equal(result.totals?.failed, 3000);
    assert.equal(result.totals?.requests, 2000);
    assert.equal(result.totals?.status5xx, 2000);
    assert.equal(result.totals?.durationMsSum, 60_000);
    assert.equal(result.operations.length, 20);
    assert.equal(result.moreOperations, true);
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

await test("application telemetry uses a half-open window and rejects malformed HTTP filters", async () => {
  const db = database();
  try {
    const batch = [event(0), { ...event(1), atMs: T0 }];
    await ingestExternal(db, "stats", await receiveEvents("stats", batch), T0);
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
