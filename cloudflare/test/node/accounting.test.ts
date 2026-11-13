import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlScopes } from "../../src/node/sql.ts";
import { PROJECT_HOUR_RETENTION_MS, PROJECT_SAMPLE_RETENTION_MS, PROJECT_STATEMENTS, purgeExpired } from "../../src/projects/store.ts";
import type { SqlDatabase, SqlValue } from "../../src/core/sql.ts";
import { fixtureBytes, NOW_MS, openHarness, withHost } from "./support.ts";

const AUDIT = "CREATE TABLE audit_deleted (project TEXT, metric TEXT, bucket_ms INTEGER)";
const PROJECT_TRIGGER = "CREATE TRIGGER deleted AFTER DELETE ON project_samples BEGIN INSERT INTO audit_deleted VALUES (old.project, old.metric, old.bucket_ms); END";
const HOUR_TRIGGER = "CREATE TRIGGER hours_deleted AFTER DELETE ON project_hours BEGIN INSERT INTO audit_deleted VALUES (old.project, old.metric, old.hour_ms); END";

function projectFixture(rowid: boolean): { db: DatabaseSync; sql: SqlDatabase } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeSqlScopes(db).open();
  for (const statement of PROJECT_STATEMENTS) sql.run(statement);
  sql.run(AUDIT);
  if (rowid) sql.run(PROJECT_TRIGGER);
  sql.run(HOUR_TRIGGER);
  return { db, sql };
}

function seed(db: DatabaseSync, count: number): void {
  db.exec("DELETE FROM project_samples");
  db.exec("DELETE FROM project_hours");
  db.exec("DELETE FROM audit_deleted");
  const expiredSample = NOW_MS - PROJECT_SAMPLE_RETENTION_MS - 1;
  const expiredHour = NOW_MS - PROJECT_HOUR_RETENTION_MS - 1;
  for (let index = 0; index < count; index += 1) {
    db.prepare("INSERT INTO project_samples (project, metric, bucket_ms, value) VALUES ('p', 'worker.invocations', ?, 1)").run(expiredSample - index);
    db.prepare("INSERT INTO project_hours (project, metric, hour_ms, value) VALUES ('p', 'worker.invocations', ?, 1)").run(expiredHour - index * 3_600_000);
  }
}

for (const count of [0, 1, 999, 1000, 1001]) {
  await test(`purgeExpired reports logical rows for ${count} expired records behind an AFTER DELETE trigger`, () => {
    const { db, sql } = projectFixture(true);
    try {
      seed(db, count);
      const first = purgeExpired(sql, NOW_MS);
      assert.deepEqual(first, { samples: Math.min(count, 1000), hours: Math.min(count, 1000) });
      const second = purgeExpired(sql, NOW_MS);
      const remaining = Math.max(0, Math.min(count, 2000) - 1000);
      assert.deepEqual(second, { samples: remaining, hours: remaining });
      const audited = Number((db.prepare("SELECT COUNT(*) AS n FROM audit_deleted").get() as { n: number }).n);
      assert.equal(audited, (Math.min(count, 1000) + remaining) * 2);
    } finally {
      db.close();
    }
  });
}

class UnmeteredSql implements SqlDatabase {
  readonly inner: SqlDatabase;
  constructor(inner: SqlDatabase) { this.inner = inner; }
  rows<T>(query: string, ...params: SqlValue[]): T[] { return this.inner.rows<T>(query, ...params); }
  each<T>(query: string, params: readonly SqlValue[], visit: (row: T) => void): void { this.inner.each<T>(query, params, visit); }
  run(query: string, ...params: SqlValue[]): void { this.inner.run(query, ...params); }
  transaction<T>(fn: () => T): T { return this.inner.transaction(fn); }
  rowsWritten(): number { throw new Error("retention decisions must not read the optional meter"); }
  total() { return this.inner.total(); }
  databaseBytes(): number { return this.inner.databaseBytes(); }
}

await test("purgeExpired does not read the optional write meter", () => {
  const { db, sql } = projectFixture(true);
  try {
    seed(db, 3);
    assert.deepEqual(purgeExpired(new UnmeteredSql(sql), NOW_MS), { samples: 3, hours: 3 });
  } finally {
    db.close();
  }
});

await test("purgeExpired rolls back as part of an enclosing transaction", () => {
  const { db, sql } = projectFixture(false);
  try {
    seed(db, 7);
    assert.throws(() => sql.transaction(() => { purgeExpired(sql, NOW_MS); throw new Error("boom"); }), /boom/);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM project_samples").get() as { n: number }).n), 7);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM project_hours").get() as { n: number }).n), 7);
  } finally {
    db.close();
  }
});

await test("an AFTER DELETE trigger does not inflate invalidation or backlog estimates on the host path", async () => {
  const harness = openHarness();
  try {
    const host = await (async () => {
      const created = await harness.core.createHost("metered");
      assert.ok(created.ok);
      return created.value;
    })();
    assert.equal((await harness.core.fetch(new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/vnd.stats.ingest.v2" }, body: withHost(fixtureBytes("frames/linux-normal.stb2"), host.hostId) }))).status, 200);
    harness.db.exec("CREATE TABLE audit_samples (host_id TEXT, boot_id TEXT, seq TEXT)");
    harness.db.exec("CREATE TRIGGER deleted AFTER DELETE ON samples BEGIN INSERT INTO audit_samples VALUES (old.host_id, old.boot_id, old.seq); END");
    const history = await harness.core.fetch(new Request(`https://installation/hosts/${host.hostId}/history?range=24h&kind=summary`, { headers: { "If-None-Match": "stale-etag" } }));
    const etag = history.headers.get("etag");
    assert.ok(etag !== null);
    const stale = await harness.core.fetch(new Request(`https://installation/hosts/${host.hostId}/history?range=24h&kind=summary`, { headers: { "If-None-Match": etag } }));
    assert.equal(stale.status, 304);
    const before = harness.db.prepare("SELECT version FROM host_history_versions WHERE host_id = ?").get(host.hostId) as { version: number };
    harness.setNow(NOW_MS + 3 * 86_400_000);
    await harness.core.alarm();
    const after = harness.db.prepare("SELECT version FROM host_history_versions WHERE host_id = ?").get(host.hostId) as { version: number };
    assert.equal(after.version, before.version + 1);
    const staleAfterChange = await harness.core.fetch(new Request(`https://installation/hosts/${host.hostId}/history?range=24h&kind=summary`, { headers: { "If-None-Match": etag } }));
    assert.equal(staleAfterChange.status, 200);
    assert.equal(Number((harness.db.prepare("SELECT COUNT(*) AS n FROM audit_samples").get() as { n: number }).n), 2);
  } finally {
    harness.close();
  }
});

await test("an alarm with nothing expired leaves the history version untouched", async () => {
  const harness = openHarness();
  try {
    const host = await (async () => {
      const created = await harness.core.createHost("clean");
      assert.ok(created.ok);
      return created.value;
    })();
    assert.equal((await harness.core.fetch(new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/vnd.stats.ingest.v2" }, body: withHost(fixtureBytes("frames/linux-normal.stb2"), host.hostId) }))).status, 200);
    const before = harness.db.prepare("SELECT version FROM host_history_versions WHERE host_id = ?").get(host.hostId) as { version: number };
    await harness.core.alarm();
    const after = harness.db.prepare("SELECT version FROM host_history_versions WHERE host_id = ?").get(host.hostId) as { version: number };
    assert.equal(after.version, before.version);
  } finally {
    harness.close();
  }
});
