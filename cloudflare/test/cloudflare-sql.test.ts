import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CloudflareSql } from "../src/cloudflare/sql";

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
