import test from "node:test";
import assert from "node:assert/strict";
import diagnostics from "node:diagnostics_channel";
import { DatabaseSync } from "node:sqlite";
import { reduceTailItem, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { POLICIES } from "../../src/observe/core/policies.ts";
import { OBSERVE_CHANNEL, type OperationMessage, type OperationSummary } from "../../src/observe/producer/channel.ts";
import { reportOperation } from "../../src/observe/producer/report.ts";
import { prepareInvocation, type MessagePolicy, type ObservedInvocation } from "../../src/observe/core/model.ts";
import { cleanup, ingest, initializeStore } from "../../src/observe/core/store.ts";
import { MAX_RETAINED_OPERATION_ROWS, OPERATION_BUCKET_MS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import { T0, VERSION, database, wrap, worker } from "./support.ts";

const POLICY: MessagePolicy = { safeNames: new Set() };
const CONTEXT = { traceId: "7bcf42a3d155dee9563e537e144790e4", spanId: "1b1e95b0d4dcde81" };
const ROWS = { read: 3, written: 5, statements: 4 };
const INGEST: OperationSummary = {
  operation: "host.ingest", synthetic: false, rows: ROWS,
  work: { received: 10, persisted: 7, duplicate: 2, rejected: { invalid_sample: 1, too_old: 0, conflict: 0 }, inputBytes: 900 }
};
const HISTORY: OperationSummary = {
  operation: "host.history", synthetic: false, rows: ROWS, workloadClass: "1h:cpu+memory",
  work: { points: 60, cells: 120, outputBytes: 4000, cache: "rebuilt" }
};

function message(summary: OperationSummary): OperationMessage {
  return { kind: "operation", ...CONTEXT, ...summary };
}

function tailItem(...messages: unknown[]): TailItem {
  return {
    event: { request: { url: "https://stats.example/ingest/v2/batches", method: "POST" }, response: { status: 200 } },
    eventTimestamp: 1_793_750_714_539, exceptions: [], diagnosticsChannelEvents: messages.map(value => ({ channel: OBSERVE_CHANNEL, message: value })),
    scriptVersion: { id: VERSION }, executionModel: "stateless", outcome: "ok", cpuTime: 2, wallTime: 30
  };
}

function reduce(...messages: unknown[]) {
  return reduceTailItem(tailItem(...messages), POLICIES.stats);
}

await test("an operation message supplies the trace context and the operation summary", () => {
  for (const summary of [INGEST, HISTORY]) {
    const reduction = reduce(message(summary));
    assert.equal(reduction.kind, "observed");
    if (reduction.kind !== "observed") continue;
    assert.deepEqual(reduction.invocation.trace, CONTEXT);
    assert.deepEqual(reduction.invocation.operation, summary);
  }
  const collector: OperationSummary = { operation: "collector.record", synthetic: false, rows: ROWS, work: { runs: 1, metricRows: 4, hourRollups: 1, upstreamQueries: 3 } };
  const retention: OperationSummary = { operation: "cleanup.retention", synthetic: true, rows: ROWS, work: { expired: 5, backlog: 0 } };
  const poll: OperationSummary = { operation: "deployments.poll", synthetic: false, rows: ROWS };
  for (const summary of [collector, retention, poll]) {
    const reduction = reduce(message(summary));
    assert.deepEqual(reduction.kind === "observed" ? reduction.invocation.operation : null, summary);
  }
});

await test("malformed operation messages and unknown kinds reject the invocation", () => {
  const good = message(INGEST);
  const withWork = (change: Record<string, unknown>) => ({ ...good, work: { ...INGEST.operation === "host.ingest" ? INGEST.work : {}, ...change } });
  const bad: unknown[] = [
    { ...good, operation: "host.made-up" },
    { ...good, synthetic: "no" },
    { ...good, rows: { read: 1, written: 2 } },
    { ...good, rows: { ...ROWS, read: -1 } },
    { ...good, rows: { ...ROWS, written: 1.5 } },
    { ...good, traceId: 7 },
    { ...good, work: undefined },
    withWork({ received: "10" }),
    withWork({ persisted: Number.MAX_SAFE_INTEGER + 2 }),
    withWork({ rejected: { invalid_sample: 1, too_old: 0 } }),
    withWork({ rejected: { invalid_sample: 1, too_old: 0, conflict: 0, other: 1 } }),
    { ...message(HISTORY), workloadClass: "Has Spaces" },
    { ...message(HISTORY), workloadClass: undefined },
    { ...message(HISTORY), work: { points: 1, cells: 1, outputBytes: 1, cache: "stale" } },
    { ...message({ operation: "deployments.poll", synthetic: false, rows: ROWS }), work: { runs: 1 } },
    { kind: "operations", ...CONTEXT }
  ];
  for (const value of bad) assert.equal(reduce(value).kind, "rejected", JSON.stringify(value));
  assert.equal(reduce(good, good).kind, "rejected");
});

await test("an instrumented invocation publishes exactly one operation message carrying the span context", () => {
  const seen: unknown[] = [];
  const subscriber = (value: unknown): void => { seen.push(value); };
  diagnostics.subscribe(OBSERVE_CHANNEL, subscriber);
  try {
    reportOperation(INGEST, CONTEXT);
  } finally {
    diagnostics.unsubscribe(OBSERVE_CHANNEL, subscriber);
  }
  assert.deepEqual(seen, [message(INGEST)]);
});

const NOW = T0 + 1000;
const BUCKET = NOW - (NOW % OPERATION_BUCKET_MS);

async function operationInvocation(n: number, overrides: Partial<ObservedInvocation> = {}) {
  const reduction = reduce(message(INGEST));
  assert.equal(reduction.kind, "observed");
  const base = reduction.kind === "observed" ? reduction.invocation : worker(n);
  const invocation: ObservedInvocation = { ...base, trace: { traceId: worker(n).trace!.traceId, spanId: worker(n).trace!.spanId }, eventAtMs: T0, ...overrides };
  return prepareInvocation(invocation, POLICY);
}

await test("operations in one receipt bucket upsert into one row, and ingest writes one extra row per batch", async () => {
  const withOperations = database();
  const plain = database();
  const batch = await Promise.all(Array.from({ length: 20 }, (_, n) => operationInvocation(n, n === 0 ? { status: 500 } : {})));
  const stripped = await Promise.all(Array.from({ length: 20 }, (_, n) => prepareInvocation({ ...worker(n), trace: worker(n).trace, eventAtMs: T0, ...(n === 0 ? { status: 500 } : {}) }, POLICY)));
  ingest(withOperations, batch, NOW);
  ingest(plain, stripped, NOW);
  const extra = withOperations.rowsWritten() - plain.rowsWritten();
  assert.equal(extra, 1);
  console.log(`rows written for 20 operation invocations: ${withOperations.rowsWritten()} against ${plain.rowsWritten()} without operations (+${extra})`);
  ingest(withOperations, await Promise.all(Array.from({ length: 20 }, (_, n) => operationInvocation(n + 20))), NOW + 10_000);
  const rows = withOperations.rows<Record<string, number | string>>("SELECT * FROM observe_operations");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual(
    [row["bucket_at"], row["version"], row["operation"], row["workload_class"], row["synthetic"], row["count"], row["failed"], row["cpu_ms_sum"], row["wall_ms_sum"]],
    [BUCKET, VERSION, "host.ingest", "", 0, 40, 1, 80, 1200]
  );
  assert.deepEqual([row["rows_read"], row["rows_written"], row["statements"]], [120, 200, 160]);
  assert.deepEqual([row["lag_count"], row["lag_ms_max"], row["lag_ms_sum"]], [40, 11_000, 20 * 1_000 + 20 * 11_000]);
  assert.deepEqual([row["received"], row["persisted"], row["duplicate"], row["rejected_invalid_sample"], row["input_bytes"], row["points"]], [400, 280, 80, 40, 36000, 0]);
});

await test("operations bucket by event time capped at receipt, so a late batch lands in the event's bucket", async () => {
  const db = database();
  ingest(db, [await operationInvocation(1, { eventAtMs: T0 + OPERATION_BUCKET_MS + 10 })], T0 + 3 * OPERATION_BUCKET_MS);
  ingest(db, [await operationInvocation(2, { eventAtMs: T0 + OPERATION_BUCKET_MS + 20 })], T0 + OPERATION_BUCKET_MS + 5);
  const rows = db.rows<{ bucket_at: number; count: number; lag_ms_max: number; lag_ms_sum: number }>("SELECT bucket_at, count, lag_ms_max, lag_ms_sum FROM observe_operations");
  assert.deepEqual(rows.map(row => ({ ...row })), [{ bucket_at: T0 + OPERATION_BUCKET_MS, count: 2, lag_ms_max: 2 * OPERATION_BUCKET_MS - 10, lag_ms_sum: 2 * OPERATION_BUCKET_MS - 10 }]);
});

await test("operations separate by bucket, class, and synthetic flag, and duplicates are not counted twice", async () => {
  const db = database();
  const history = reduce(message(HISTORY));
  const first = await operationInvocation(1);
  ingest(db, [first], NOW);
  ingest(db, [first], NOW + 1);
  ingest(db, [await operationInvocation(4, { eventAtMs: T0 + OPERATION_BUCKET_MS })], NOW + OPERATION_BUCKET_MS);
    const classed = history.kind === "observed" ? await prepareInvocation({ ...history.invocation, trace: worker(2).trace, eventAtMs: T0 }, POLICY) : first;
  ingest(db, [classed], NOW);
  const synthetic = reduce(message({ ...INGEST, synthetic: true }));
  ingest(db, [synthetic.kind === "observed" ? await prepareInvocation({ ...synthetic.invocation, trace: worker(3).trace, eventAtMs: T0 }, POLICY) : first], NOW);
  const rows = db.rows<{ operation: string; workload_class: string; synthetic: number; count: number }>("SELECT operation, workload_class, synthetic, count FROM observe_operations ORDER BY bucket_at, operation, synthetic");
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(DISTINCT bucket_at) AS n FROM observe_operations")[0]!.n, 2);
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { operation: "host.history", workload_class: "1h:cpu+memory", synthetic: 0, count: 1 },
    { operation: "host.ingest", workload_class: "", synthetic: 0, count: 1 },
    { operation: "host.ingest", workload_class: "", synthetic: 1, count: 1 },
    { operation: "host.ingest", workload_class: "", synthetic: 0, count: 1 }
  ]);
});

await test("opening a store populated before operations adds the table and keeps every row", async () => {
  const legacy = new DatabaseSync(":memory:");
  const store = wrap(legacy);
  initializeStore(store);
  ingest(store, [await prepareInvocation({ ...worker(1), eventAtMs: T0 }, POLICY), await prepareInvocation({ ...worker(2), eventAtMs: T0 }, POLICY)], NOW);
  store.run("DROP TABLE observe_operations");
  const tables = (): string[] => store.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(row => row.name);
  const before = tables().filter(name => name !== "observe_operations");
  const counted = Object.fromEntries(before.map(name => [name, store.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)[0]!.n]));
  initializeStore(store);
  initializeStore(store);
  assert.deepEqual(tables(), [...before, "observe_operations"].sort());
  for (const name of before) assert.equal(store.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)[0]!.n, counted[name], name);
  assert.equal(counted["observe_invocations"], 2);
});

await test("cleanup expires operation buckets with the retention window and caps the table", async () => {
  const db = database();
  ingest(db, [await operationInvocation(1)], NOW);
  cleanup(db, NOW + RETENTION_MS - OPERATION_BUCKET_MS);
  assert.equal(db.rows("SELECT 1 FROM observe_operations").length, 1);
  cleanup(db, NOW + RETENTION_MS + OPERATION_BUCKET_MS * 2);
  assert.equal(db.rows("SELECT 1 FROM observe_operations").length, 0);
  db.run(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_RETAINED_OPERATION_ROWS + 50}) INSERT INTO observe_operations (bucket_at, version, operation, workload_class, synthetic, count, failed, cpu_ms_sum, wall_ms_sum, rows_read, rows_written, statements) SELECT ${NOW} + i, 'v', 'host.ingest', '', 0, 1, 0, 0, 0, 0, 0, 0 FROM n`);
  cleanup(db, NOW);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_operations")[0]!.n, MAX_RETAINED_OPERATION_ROWS);
});
