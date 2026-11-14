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
