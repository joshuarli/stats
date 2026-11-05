import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../../src/observe/http/api.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { decodeStatsWindow } from "../../src/observe/client/decode.ts";
import { prepareInvocation, type MessagePolicy, type ObservedInvocation, type OutcomeEvent, OTHER_ROUTE } from "../../src/observe/core/model.ts";
import { ingest, statsWindow } from "../../src/observe/core/store.ts";
import { OBSERVE_FILTER_REVISION, OPERATION_BUCKET_MS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import type { OperationSummary } from "../../src/observe/producer/channel.ts";
import { T0, database, worker } from "./support.ts";

const POLICY: MessagePolicy = { safeNames: new Set() };
const V1 = "00000000-0000-4000-8000-000000000101";
const V2 = "00000000-0000-4000-8000-000000000102";
const H = 3_600_000;
const START = T0 - T0 % OPERATION_BUCKET_MS;
const INGEST: OperationSummary = {
  operation: "host.ingest", synthetic: false, rows: { read: 3, written: 5, statements: 4 },
  work: { received: 10, persisted: 7, duplicate: 2, rejected: { invalid_sample: 1, too_old: 0, conflict: 0 }, inputBytes: 900 }
};
const HISTORY: OperationSummary = {
  operation: "host.history", synthetic: false, rows: { read: 10, written: 0, statements: 2 }, workloadClass: "1h:cpu",
  work: { points: 60, cells: 120, outputBytes: 4000, cache: "rebuilt" }
};

let sequence = 0;
async function receive(db: ReturnType<typeof database>, at: number, version: string, summary: OperationSummary, now = at + 1000): Promise<void> {
  sequence += 1;
  const invocation: ObservedInvocation = { ...worker(sequence, { version, eventAtMs: at }), operation: summary };
  const prepared = await prepareInvocation(invocation, POLICY);
  ingest(db, [prepared], now);
}

await test("a rolled-back version inherits nothing from its earlier deployment", async () => {
  const db = database();
  await receive(db, START, V1, INGEST);
  await receive(db, START + H, V2, INGEST);
  await receive(db, START + 3 * H, V1, INGEST);
  await receive(db, START + 3 * H + OPERATION_BUCKET_MS, V1, INGEST);
  const after = statsWindow(db, { fromMs: START + 3 * H, toMs: START + 4 * H, operation: "host.ingest" });
  assert.deepEqual(after.operations.map(row => [row.bucketAt, row.version, row.count]), [[START + 3 * H, V1, 1], [START + 3 * H + OPERATION_BUCKET_MS, V1, 1]]);
  const before = statsWindow(db, { fromMs: START + H, toMs: START + 2 * H, operation: "host.ingest" });
  assert.deepEqual(before.operations.map(row => [row.version, row.count]), [[V2, 1]]);
  assert.deepEqual(statsWindow(db, { fromMs: START + 2 * H, toMs: START + 3 * H }).operations, []);
  assert.equal("counts" in after, false, "a service that keeps everything has no counted routes");
});

await test("the window is half-open and sums operation, outcome and observed counts per bucket and version", async () => {
  const db = database();
  await receive(db, START, V1, INGEST);
  await receive(db, START + 10, V1, INGEST);
  await receive(db, START + OPERATION_BUCKET_MS, V1, { ...INGEST, synthetic: true });
  await receive(db, START + 2 * OPERATION_BUCKET_MS, V1, INGEST);
  await receive(db, START, V1, HISTORY);
  const events: OutcomeEvent[] = [
    { version: V1, stage: "worker", outcome: "excluded-status:404", route: "GET /x", eventAtMs: START + 5 },
    { version: V1, stage: "worker", outcome: "excluded-status:404", route: OTHER_ROUTE, eventAtMs: START + 6 },
    { version: V1, stage: "worker", outcome: "excluded-route", route: OTHER_ROUTE, eventAtMs: START + 2 * OPERATION_BUCKET_MS }
  ];
  ingest(db, [], START + 2 * OPERATION_BUCKET_MS + 1000, events);
  const window = statsWindow(db, { fromMs: START, toMs: START + 2 * OPERATION_BUCKET_MS, operation: "host.ingest" });
  assert.equal(window.filterRevision, OBSERVE_FILTER_REVISION);
  assert.deepEqual(window.operations.map(row => [row.bucketAt - START, row.synthetic, row.count, row.work.persisted, row.rowsWritten]), [[0, false, 2, 14, 10], [OPERATION_BUCKET_MS, true, 1, 7, 5]]);
  assert.deepEqual(window.outcomes.map(row => [row.outcome, row.count, row.filterRevision]), [["excluded-status:404", 2, OBSERVE_FILTER_REVISION]]);
  assert.deepEqual(window.invocations.map(row => [row.bucketAt - START, row.stage, row.count]), [[0, "worker", 3], [OPERATION_BUCKET_MS, "worker", 1]]);
  assert.ok(window.lag.operations.count > 0 && window.lag.operations.maxMs === 1000);
  const classed = statsWindow(db, { fromMs: START, toMs: START + OPERATION_BUCKET_MS, operation: "host.history", workloadClass: "other" });
  assert.deepEqual(classed.operations, []);
  assert.deepEqual(decodeStatsWindow(JSON.parse(JSON.stringify(window))), window);
});

await test("the window route validates its bounds and filters strictly", async () => {
  const db = database();
  const service = createObserveService(db, { now: () => START + 10 * H, databaseBytes: () => 0 });
  const get = (query: string) => handleApi(new Request(`https://observe.test/window${query}`), "/window", service);
  const ok = await get(`?from=${START}&to=${START + H}&operation=host.ingest`);
  assert.equal(ok.status, 200);
  assert.equal(decodeStatsWindow(await ok.json()).operation, "host.ingest");
  assert.equal((await get(`?from=${START}&to=${START + RETENTION_MS}`)).status, 200);
  const invalid = [
    "", `?from=${START}`, `?to=${START + H}`,
    `?from=${START + 1}&to=${START + H}`, `?from=${START}&to=${START + H + 1}`,
    `?from=${START + H}&to=${START}`, `?from=${START}&to=${START}`,
    `?from=${START}&to=${START + RETENTION_MS + OPERATION_BUCKET_MS}`,
    `?from=${START}&to=${START + H}&operation=nope`, `?from=${START}&to=${START + H}&class=1h:cpu`,
    `?from=${START}&to=${START + H}&operation=host.history&class=`, `?from=${START}&to=${START + H}&route=x`,
    `?from=${START}&from=${START}&to=${START + H}`, `?from=-300000&to=0`
  ];
  for (const query of invalid) assert.equal((await get(query)).status, 400, query);
  assert.equal((await handleApi(new Request("https://observe.test/window", { method: "POST" }), "/window", service)).status, 405);
});
