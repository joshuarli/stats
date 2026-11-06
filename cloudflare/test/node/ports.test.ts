import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TimerScheduler, systemClock } from "../../src/node/ports.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
}

function values(rows: readonly { v: string }[]): string[] {
  return rows.map(row => row.v);
}

function opened() {
  const db = new DatabaseSync(":memory:");
  const scopes = nodeSqlScopes(db);
  scopes.open().run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
  return { db, scopes };
}

await test("a node:sqlite transaction commits on return and rolls back on a throw", () => {
  const { db, scopes } = opened();
  const sql = scopes.open();
  sql.transaction(() => sql.run("INSERT INTO t (v) VALUES ('kept')"));
  assert.throws(() => sql.transaction(() => { sql.run("INSERT INTO t (v) VALUES ('lost')"); throw new Error("abort"); }), /abort/u);
  assert.deepEqual(values(sql.rows<{ v: string }>("SELECT v FROM t")), ["kept"]);
  db.close();
});

await test("a nested node:sqlite transaction rolls back alone and the outer one still commits", () => {
  const { db, scopes } = opened();
  const sql = scopes.open();
  sql.transaction(() => {
    sql.run("INSERT INTO t (v) VALUES ('outer')");
    assert.throws(() => sql.transaction(() => { sql.run("INSERT INTO t (v) VALUES ('inner')"); throw new Error("abort"); }), /abort/u);
    sql.transaction(() => sql.run("INSERT INTO t (v) VALUES ('second')"));
  });
  assert.deepEqual(values(sql.rows<{ v: string }>("SELECT v FROM t ORDER BY id")), ["outer", "second"]);
  db.close();
});

await test("statements from two accounting scopes share one transaction on the same database", () => {
  const { db, scopes } = opened();
  const first = scopes.open();
  const second = scopes.open();
  assert.throws(() => first.transaction(() => { second.run("INSERT INTO t (v) VALUES ('through the other scope')"); throw new Error("abort"); }), /abort/u);
  assert.equal(count(db, "t"), 0);
  db.close();
});

await test("each node:sqlite scope counts its own statements and the table rows its writes changed", () => {
  const { db, scopes } = opened();
  const first = scopes.open();
  const second = scopes.open();
  first.run("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')");
  first.rows("SELECT v FROM t");
  first.each("SELECT v FROM t", [], () => {});
  assert.equal(first.rowsWritten(), 3);
  assert.equal(first.total().written, 3);
  assert.equal(first.total().statements, 3);
  assert.deepEqual({ written: second.total().written, statements: second.total().statements }, { written: 0, statements: 0 });
  db.close();
});

await test("the node:sqlite adapter reports the database size in bytes", () => {
  const { db, scopes } = opened();
  const sql = scopes.open();
  const empty = sql.databaseBytes();
  for (let row = 0; row < 500; row += 1) sql.run("INSERT INTO t (v) VALUES (?)", "x".repeat(200));
  assert.ok(empty > 0);
  assert.ok(sql.databaseBytes() > empty);
  db.close();
});

await test("the timer scheduler fires the latest requested time once and reports it pending until then", async () => {
  const fired: number[] = [];
  const scheduler = new TimerScheduler(systemClock, async () => { fired.push(Date.now()); }, error => { throw error; });
  assert.equal(await scheduler.pending(), null);
  const first = Date.now() + 5_000;
  await scheduler.at(first);
  const second = Date.now() + 30;
  await scheduler.at(second);
  assert.equal(await scheduler.pending(), second);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(fired.length, 1);
  assert.ok(fired[0]! >= second);
  assert.equal(await scheduler.pending(), null);
});

await test("the timer scheduler reports a failed alarm and stays usable", async () => {
  const failures: unknown[] = [];
  const scheduler = new TimerScheduler(systemClock, async () => { throw new Error("retention failed"); }, error => { failures.push(error); });
  await scheduler.at(Date.now());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(failures.length, 1);
  assert.equal(await scheduler.pending(), null);
  await scheduler.at(Date.now() + 60_000);
  assert.ok((await scheduler.pending()) !== null);
  scheduler.stop();
  assert.equal(await scheduler.pending(), null);
});

await test("a stopped timer scheduler ignores a request made after stop, as a run in flight during close makes", async () => {
  const fired: number[] = [];
  const scheduler = new TimerScheduler(systemClock, async () => { fired.push(Date.now()); }, error => { throw error; });
  scheduler.stop();
  await scheduler.at(Date.now());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(fired, []);
  assert.equal(await scheduler.pending(), null);
});
