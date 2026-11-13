import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CloudflareSql } from "../src/cloudflare/sql";
import { affectedBy } from "../src/operations";
import { PROJECT_STATEMENTS, purgeExpired } from "../src/projects/store";

function run<T>(name: string, body: (sql: SqlStorage, account: CloudflareSql, storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(env.INSTALLATION.get(env.INSTALLATION.idFromName(name)), async (_instance, state) => body(state.storage.sql, new CloudflareSql(state.storage), state.storage));
}

describe("Cloudflare SQL accounting", () => {
  it("counts a table write and its index rows from the consumed cursor", () => run("account-index", (sql, account, storage) => {
    sql.exec("CREATE TABLE plain (id INTEGER PRIMARY KEY, a TEXT)");
    sql.exec("CREATE TABLE indexed (id INTEGER PRIMARY KEY, a TEXT, b TEXT)");
    sql.exec("CREATE INDEX indexed_a ON indexed (a)");
    sql.exec("CREATE INDEX indexed_b ON indexed (b)");
    const plain = new CloudflareSql(storage);
    plain.run("INSERT INTO plain (id, a) VALUES (1, 'x')");
    const rows = new CloudflareSql(storage);
    rows.run("INSERT INTO indexed (id, a, b) VALUES (1, 'x', 'y')");
    expect(plain.total().written).toBe(1);
    expect(rows.total().written).toBe(3);
    expect(rows.total().statements).toBe(1);
    expect(account.total()).toEqual({ read: 0, written: 0, statements: 0 });
  }));

  it("accumulates reads and writes across statements and matches the cursor totals", () => run("account-sum", (sql, account) => {
    sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
    account.run("INSERT INTO t (id, v) VALUES (1, 1), (2, 2), (3, 3), (4, 4)");
    const selected = account.rows<{ v: number }>("SELECT v FROM t WHERE v > 1");
    account.run("UPDATE t SET v = v + 1 WHERE id <= 2");
    const reference = sql.exec("SELECT v FROM t");
    reference.toArray();
    expect(selected).toHaveLength(3);
    const total = account.total();
    expect(total.statements).toBe(3);
    expect(total.written).toBeGreaterThanOrEqual(6);
    expect(total.read).toBeGreaterThanOrEqual(reference.rowsRead);
  }));

  it("counts logical rows deleted behind an index and an AFTER DELETE trigger, not billable rows", () => run("account-logical", (sql, account) => {
    sql.exec("CREATE TABLE samples_probe (id INTEGER PRIMARY KEY, received_at_ms INTEGER)");
    sql.exec("CREATE INDEX samples_probe_time ON samples_probe (received_at_ms)");
    sql.exec("CREATE TABLE audit_deleted (id INTEGER)");
    sql.exec("CREATE TRIGGER deleted AFTER DELETE ON samples_probe BEGIN INSERT INTO audit_deleted VALUES (old.id); END");
    account.run("INSERT INTO samples_probe (id, received_at_ms) VALUES (1, 1), (2, 2), (3, 3), (4, 4)");
    expect(affectedBy(account, "DELETE FROM samples_probe WHERE received_at_ms < ?", 3)).toBe(2);
    expect(account.rowsWritten()).toBeGreaterThanOrEqual(4);
    sql.exec("INSERT INTO samples_probe (id, received_at_ms) VALUES (5, 5)");
    expect(affectedBy(account, "DELETE FROM samples_probe WHERE received_at_ms >= ?", 4)).toBe(2);
    expect(affectedBy(account, "DELETE FROM samples_probe WHERE received_at_ms >= ?", 100)).toBe(0);
  }));

  it("purgeExpired reports only the logical batch behind trigger-inclusive totals", () => run("account-purge", (sql, account) => {
    for (const statement of PROJECT_STATEMENTS) sql.exec(statement);
    sql.exec("CREATE TABLE audit_deleted2 (bucket_ms INTEGER)");
    sql.exec("CREATE TRIGGER project_samples_deleted AFTER DELETE ON project_samples BEGIN INSERT INTO audit_deleted2 VALUES (old.bucket_ms); END");
    sql.exec("CREATE TRIGGER project_hours_deleted AFTER DELETE ON project_hours BEGIN INSERT INTO audit_deleted2 VALUES (old.hour_ms); END");
    const expiredSample = Date.now() - 8 * 24 * 3_600_000;
    const expiredHour = Date.now() - 31 * 24 * 3_600_000;
    const batch = 5;
    for (let index = 0; index < batch; index += 1) {
      sql.exec("INSERT INTO project_samples (project, metric, bucket_ms, value) VALUES ('p', 'worker.invocations', ?, 1)", expiredSample - index);
      sql.exec("INSERT INTO project_hours (project, metric, hour_ms, value) VALUES ('p', 'worker.invocations', ?, 1)", expiredHour - index * 3_600_000);
    }
    expect(purgeExpired(account, Date.now())).toEqual({ samples: batch, hours: batch });
    expect(purgeExpired(account, Date.now())).toEqual({ samples: 0, hours: 0 });
  }));

  it("counts rows read by an iterated statement only once the loop has consumed it", () => run("account-each", (sql, account) => {
    sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
    sql.exec("INSERT INTO t (id, v) VALUES (1, 1), (2, 2), (3, 3)");
    const seen: number[] = [];
    account.each<{ v: number }>("SELECT v FROM t", [], row => seen.push(row.v));
    expect(seen).toEqual([1, 2, 3]);
    expect(account.total().read).toBeGreaterThanOrEqual(3);
    expect(account.total().statements).toBe(1);
  }));
});
