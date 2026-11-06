import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { prepareTailItems, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { AlwaysKeptCap } from "../../src/observe/core/always-kept-cap.ts";
import { POLICIES } from "../../src/observe/core/policies.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";
import { OTHER_ROUTE, prepareInvocation, type MessagePolicy, type OutcomeEvent } from "../../src/observe/core/model.ts";
import { cleanup, ingest, initializeStore } from "../../src/observe/core/store.ts";
import { MAX_OUTCOME_ROUTES_PER_CLASS, MAX_RETAINED_OUTCOME_ROWS, OBSERVE_FILTER_REVISION, OUTCOME_BUCKET_MS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import { T0, VERSION, database, wrap, worker } from "./support.ts";

const POLICY: MessagePolicy = { safeNames: new Set() };
const NOW = T0 + 2 * OUTCOME_BUCKET_MS + 10_000;
const BUCKET = NOW - (NOW % OUTCOME_BUCKET_MS);
const CONTEXT = { traceId: "7bcf42a3d155dee9563e537e144790e4", spanId: "1b1e95b0d4dcde81" };

function fetchItem(url: string, status: number, overrides: Partial<TailItem> = {}): TailItem {
  return {
    event: { request: { url, method: "GET" }, response: { status } },
    eventTimestamp: NOW - 2_000, exceptions: [], diagnosticsChannelEvents: [{ channel: OBSERVE_CHANNEL, message: { kind: "invocation", ...CONTEXT } }],
    scriptVersion: { id: VERSION }, executionModel: "stateless", outcome: "ok", cpuTime: 2, wallTime: 30, ...overrides
  };
}

interface OutcomeRow { stage: string; outcome: string; route: string; count: number; lag_count: number; lag_ms_max: number; lag_ms_sum: number; filter_revision: number; bucket_at: number; version: string }

function outcomes(db: ReturnType<typeof database>): OutcomeRow[] {
  return db.rows<OutcomeRow>("SELECT * FROM observe_outcomes ORDER BY outcome, route, stage").map(row => ({ ...row }));
}

async function receive(db: ReturnType<typeof database>, items: readonly TailItem[], at = NOW): Promise<void> {
  const batch = await prepareTailItems(items, POLICIES.stats, at, new AlwaysKeptCap());
  ingest(db, batch.preparations, at, batch.outcomes);
}

await test("a 404 is counted by status and route but never retained as an invocation", async () => {
  const db = database();
  await receive(db, [fetchItem("https://stats.example/api/v1/projects/p1", 404), fetchItem("https://stats.example/api/v1/projects/p1", 401), fetchItem("https://stats.example/ingest/v2/batches", 403)]);
  assert.equal(db.rows("SELECT 1 FROM observe_invocations").length, 0);
  assert.deepEqual(outcomes(db).map(row => [row.outcome, row.route, row.count]), [
    ["excluded-status:401", "GET /api/v1/projects/:project", 1],
    ["excluded-status:403", "GET /ingest/v2/batches", 1],
    ["excluded-status:404", "GET /api/v1/projects/:project", 1]
  ]);
});

await test("an unmapped path is excluded-route under other, and an unmapped 404 is also under other", async () => {
  const db = database();
  await receive(db, [fetchItem("https://stats.example/favicon.ico", 200), fetchItem("https://stats.example/favicon.ico", 200), fetchItem("https://stats.example/robots.txt", 404)]);
  assert.deepEqual(outcomes(db).map(row => [row.outcome, row.route, row.count]), [["excluded-route", OTHER_ROUTE, 2], ["excluded-status:404", OTHER_ROUTE, 1]]);
});

await test("invalid events and invalid invocations are counted rejected-invalid, and observed events write no outcome row", async () => {
  const db = database();
  const badStage = fetchItem("https://stats.example/ingest/v2/batches", 200, { executionModel: "other" });
  const noTimestamp = fetchItem("https://stats.example/ingest/v2/batches", 200, { eventTimestamp: null });
  const badTrace = fetchItem("https://stats.example/ingest/v2/batches", 200, { diagnosticsChannelEvents: [{ channel: OBSERVE_CHANNEL, message: { kind: "invocation", traceId: 7 } }] });
  const good = fetchItem("https://stats.example/ingest/v2/batches", 200);
  await receive(db, [badStage, noTimestamp, badTrace, good]);
  assert.deepEqual(outcomes(db).map(row => [row.stage, row.outcome, row.route, row.count, row.lag_count]), [
    ["unknown", "rejected-invalid", OTHER_ROUTE, 1, 1],
    ["worker", "rejected-invalid", OTHER_ROUTE, 2, 1]
  ]);
  assert.equal(db.rows("SELECT 1 FROM observe_invocations").length, 1);
});

await test("a batch of only observed invocations writes no outcome row", async () => {
  const db = database();
  const batch = await prepareTailItems([fetchItem("https://stats.example/ingest/v2/batches", 200)], POLICIES.stats, NOW, new AlwaysKeptCap());
  assert.deepEqual(batch.outcomes, []);
  ingest(db, batch.preparations, NOW, batch.outcomes);
  assert.equal(db.rows("SELECT 1 FROM observe_outcomes").length, 0);
});

await test("outcomes bucket by event time capped at receipt, and lag keeps the max and sum, clamps negatives, and skips events without a timestamp", async () => {
  const db = database();
  const missing = (at: number | null) => fetchItem("https://stats.example/favicon.ico", 200, { eventTimestamp: at });
  await receive(db, [missing(NOW - 4_000), missing(NOW + 90_000), missing(NOW - 1_000), missing(NOW - OUTCOME_BUCKET_MS - 500)]);
  await receive(db, [missing(NOW - 9_000), missing(null)], NOW + 10_000);
  const rows = outcomes(db);
  assert.deepEqual(rows.map(row => [row.bucket_at, row.count, row.lag_count, row.lag_ms_max, row.lag_ms_sum, row.filter_revision]), [
    [BUCKET - OUTCOME_BUCKET_MS, 1, 1, OUTCOME_BUCKET_MS + 500, OUTCOME_BUCKET_MS + 500, OBSERVE_FILTER_REVISION],
    [BUCKET, 4, 4, 19_000, 4_000 + 0 + 1_000 + 19_000, OBSERVE_FILTER_REVISION],
    [BUCKET, 1, 0, 0, 0, OBSERVE_FILTER_REVISION]
  ]);
});

await test("one upsert per bucket key per batch bounds the rows written", async () => {
  const db = database();
  const items = Array.from({ length: 50 }, () => fetchItem("https://stats.example/favicon.ico", 404));
  const batch = await prepareTailItems(items, POLICIES.stats, NOW, new AlwaysKeptCap());
  const before = db.rowsWritten();
  ingest(db, batch.preparations, NOW, batch.outcomes);
  const first = db.rowsWritten() - before;
  ingest(db, batch.preparations, NOW + 1, batch.outcomes);
  assert.equal(outcomes(db).length, 1);
  assert.equal(outcomes(db)[0]!.count, 100);
  assert.equal(db.rowsWritten() - before - first, first);
  assert.ok(first <= 3, `rows written for 50 excluded events: ${first}`);
});

await test("distinct routes per class are capped, with the overflow folded into other", async () => {
  const db = database();
  const spread = Array.from({ length: MAX_OUTCOME_ROUTES_PER_CLASS + 20 }, (_, n) => fetchItem(`https://stats.example/api/v1/scan${n}`, 404));
  await receive(db, spread);
  await receive(db, spread.slice(0, 5), NOW + 1);
  const rows = outcomes(db);
  assert.equal(rows.length, MAX_OUTCOME_ROUTES_PER_CLASS + 1);
  assert.equal(rows.find(row => row.route === OTHER_ROUTE)!.count, 20);
  assert.equal(rows.reduce((total, row) => total + row.count, 0), spread.length + 5);
});

await test("unknown-service events are accepted by the store as their own class", () => {
  const db = database();
  const event: OutcomeEvent = { version: "", stage: "unknown", outcome: "unknown-service", route: OTHER_ROUTE, eventAtMs: NOW - 500 };
  ingest(db, [], NOW, [event, event]);
  assert.deepEqual(outcomes(db).map(row => [row.outcome, row.stage, row.count, row.lag_ms_sum]), [["unknown-service", "unknown", 2, 1_000]]);
});

await test("opening a store populated before outcomes adds the table and keeps every row", async () => {
  const store = wrap(new DatabaseSync(":memory:"));
  initializeStore(store);
  ingest(store, [await prepareInvocation({ ...worker(1), eventAtMs: T0 }, POLICY), await prepareInvocation({ ...worker(2), eventAtMs: T0 }, POLICY)], NOW);
  store.run("DROP TABLE observe_outcomes");
  const tables = (): string[] => store.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(row => row.name);
  const before = tables().filter(name => name !== "observe_outcomes");
  const counted = Object.fromEntries(before.map(name => [name, store.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)[0]!.n]));
  initializeStore(store);
  initializeStore(store);
  assert.deepEqual(tables(), [...before, "observe_outcomes"].sort());
  for (const name of before) assert.equal(store.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)[0]!.n, counted[name], name);
  assert.equal(counted["observe_invocations"], 2);
});

await test("cleanup expires outcome buckets with the retention window and caps the table", () => {
  const db = database();
  const event: OutcomeEvent = { version: VERSION, stage: "worker", outcome: "excluded-route", route: OTHER_ROUTE, eventAtMs: NOW };
  ingest(db, [], NOW, [event]);
  cleanup(db, NOW + RETENTION_MS - OUTCOME_BUCKET_MS);
  assert.equal(db.rows("SELECT 1 FROM observe_outcomes").length, 1);
  cleanup(db, NOW + RETENTION_MS + OUTCOME_BUCKET_MS * 2);
  assert.equal(db.rows("SELECT 1 FROM observe_outcomes").length, 0);
  db.run(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_RETAINED_OUTCOME_ROWS + 50}) INSERT INTO observe_outcomes (bucket_at, version, stage, outcome, route, count, lag_count, lag_ms_max, lag_ms_sum, filter_revision) SELECT ${NOW} + i, 'v', 'worker', 'excluded-route', 'r', 1, 0, 0, 0, 1 FROM n`);
  cleanup(db, NOW);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_outcomes")[0]!.n, MAX_RETAINED_OUTCOME_ROWS);
});
