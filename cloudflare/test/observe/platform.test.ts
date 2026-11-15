import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestExternal } from "../../src/observe/core/store.ts";
import { readPlatformTelemetry } from "../../src/observe/platform/query.ts";
import { receiveEvents } from "../../src/observe/ingest/failures.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";
import { PLATFORM_SERVICE } from "../../../packages/platform-bridge/src/contract.ts";
import { database, T0, H } from "./support.ts";
const event = (n: number, durationUs: number, operation = "platform.installation.invoke"): ExternalEvent => ({ schemaVersion: 1, eventId: `p-${n}`, atMs: T0 - 1000 + n, service: PLATFORM_SERVICE, release: "stats-r1_oo-1.0.2_rk-3.1.2-rc.1", operation, durationMs: Math.round(durationUs / 1000), outcome: n === 0 ? "error" : "ok", work: { duration_us: durationUs, sample_ppm: 100000 } });
await test("platform histograms preserve sampled counts, errors, releases and microsecond bounds", async () => {
  const db = database();
  try {
    const batch = [event(0, 10), event(1, 80), event(2, 300), event(3, 1250), event(4, 10, "platform.observation.sqlite.execute"), { ...event(5, 5), release: "r2" }];
    ingestExternal(db, PLATFORM_SERVICE, await receiveEvents(PLATFORM_SERVICE, batch), T0);
    const result = readPlatformTelemetry(db, PLATFORM_SERVICE, T0, { fromMs: T0 - H, toMs: T0 });
    const row = result.operations.find(row => row.operation === "platform.installation.invoke" && row.release !== "r2")!;
    assert.equal(row.count, 4);
    assert.equal(row.failed, 1);
    assert.equal(row.meanUs, 410);
    assert.equal(row.maxUs, 1250);
    assert.equal(row.p50UpperUs, 100);
    assert.equal(row.p95UpperUs, 2500);
    assert.deepEqual(row.histogram, [{ upperUs: 10, count: 1 }, { upperUs: 100, count: 1 }, { upperUs: 500, count: 1 }, { upperUs: 2500, count: 1 }]);
    assert.equal(result.operations.length, 3);
    assert.equal(result.delivery, null);
    assert.deepEqual(result.capabilities, { actorRequests: true, sqlite: true, outboundRpc: false, runtimeMetrics: false });
    assert.equal(result.truncated, false);
    assert.throws(() => readPlatformTelemetry(db, "stats", T0, {}), /dedicated sink/u);
  } finally { db.db.close(); }
});
await test("bridge delivery remains explicit and does not enter actor distributions", async () => {
  const db = database();
  try {
    const report: ExternalEvent = { ...event(0, 0, "platform.bridge"), outcome: "ok", work: { received: 100, admitted: 50, filtered: 48, invalid: 2, dropped: 3, queued: 4, sent: 43, sample_ppm: 100000 } };
    ingestExternal(db, PLATFORM_SERVICE, await receiveEvents(PLATFORM_SERVICE, [report]), T0);
    const result = readPlatformTelemetry(db, PLATFORM_SERVICE, T0, {});
    assert.deepEqual(result.operations, []);
    assert.deepEqual(result.delivery, { atMs: report.atMs, release: report.release, received: 100, admitted: 50, filtered: 48, invalid: 2, dropped: 3, queued: 4, sent: 43, samplePpm: 100000, exporterLoss: "unknown" });
  } finally { db.db.close(); }
});
await test("platform reads keep groups complete at the release cap and honor half-open windows", async () => {
  const db = database();
  try {
    const batch = Array.from({ length: 100 }, (_, n) => ({ ...event(n, n * 100), release: `r${n}` }));
    ingestExternal(db, PLATFORM_SERVICE, await receiveEvents(PLATFORM_SERVICE, batch), T0);
    const result = readPlatformTelemetry(db, PLATFORM_SERVICE, T0, { fromMs: T0 - 1000, toMs: T0 - 901 });
    assert.equal(result.operations.length, 80);
    assert.equal(result.truncated, true);
    assert.ok(result.operations.every(row => row.histogram.reduce((sum, bucket) => sum + bucket.count, 0) === row.count));
    assert.ok(result.operations.every(row => row.release !== "r99"));
  } finally { db.db.close(); }
});
