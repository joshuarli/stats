import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CLEANUP_BATCH, CLEANUP_INTERVAL_MS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import { cleanup, health, initializeStore, nextCleanupAt } from "../../src/observe/core/store.ts";
import { database, T0, wrap } from "./support.ts";

const now = T0 + RETENTION_MS;
const cutoff = T0;

function insert(db: ReturnType<typeof database>, id: string, received: number, event: number): void {
  db.run("INSERT INTO observe_external_events VALUES (?, ?, ?, ?, ?, ?)", "service", id, received, event, "application", "{}");
}

test("external expiry uses either timestamp including the cutoff", () => {
  const db = database();
  insert(db, "received", cutoff, cutoff + 1);
  insert(db, "event", cutoff + 1, cutoff);
  insert(db, "both", cutoff - 1, cutoff - 1);
  insert(db, "retained", cutoff + 1, cutoff + 1);
  assert.deepEqual(cleanup(db, now), { deleted: 3, evicted: 0, more: false });
  assert.deepEqual(db.rows<{ event_id: string }>("SELECT event_id FROM observe_external_events").map(row => row.event_id), ["retained"]);
  const report = health(db, now);
  assert.equal(report.evicted, 0);
  assert.equal(report.writes.cleanupRows, 3);
  assert.equal(report.writes.accepted, 0);
});

test("external cleanup is bounded and immediately schedules a backlog", () => {
  const db = database();
  for (let i = 0; i < CLEANUP_BATCH + 1; i++) insert(db, String(i), cutoff, cutoff + 1);
  const first = cleanup(db, now);
  assert.deepEqual(first, { deleted: CLEANUP_BATCH, evicted: 0, more: true });
  assert.equal(nextCleanupAt(db, now, first), now);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_external_events")[0]!.n, 1);
  assert.equal(health(db, now).writes.cleanupRows, CLEANUP_BATCH);
  const second = cleanup(db, now);
  assert.deepEqual(second, { deleted: 1, evicted: 0, more: false });
  assert.equal(nextCleanupAt(db, now, second), null);
  assert.equal(health(db, now).writes.cleanupRows, CLEANUP_BATCH + 1);
});

test("next expiry considers both timestamps and respects the moving interval floor", () => {
  const db = database();
  insert(db, "event", cutoff + 10, cutoff + 2);
  insert(db, "received", cutoff + 1, cutoff + 20);
  const cleaned = { deleted: 0, evicted: 0, more: false };
  assert.equal(nextCleanupAt(db, T0, cleaned), cutoff + 1 + RETENTION_MS);
  assert.equal(nextCleanupAt(db, now, cleaned), now + CLEANUP_INTERVAL_MS);
  assert.equal(nextCleanupAt(db, now + 10, cleaned), now + 10 + CLEANUP_INTERVAL_MS);
});

test("existing external-event tables acquire expiry indexes without rewriting rows", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE observe_external_events (service TEXT NOT NULL, event_id TEXT NOT NULL, received_at INTEGER NOT NULL, event_at INTEGER NOT NULL, provenance TEXT NOT NULL CHECK (provenance = 'application'), payload TEXT NOT NULL, PRIMARY KEY (service, event_id)) WITHOUT ROWID");
  raw.exec("INSERT INTO observe_external_events VALUES ('service', 'old', 1, 2, 'application', '{}')");
  const db = wrap(raw);
  initializeStore(db);
  initializeStore(db);
  assert.deepEqual(db.rows<{ event_id: string }>("SELECT event_id FROM observe_external_events").map(row => row.event_id), ["old"]);
  assert.equal(db.rows("SELECT name FROM sqlite_master WHERE name IN ('observe_external_events_event_at', 'observe_external_events_received_at')").length, 2);
});
