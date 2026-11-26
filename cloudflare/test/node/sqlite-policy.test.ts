import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { configureSqlite, checkpointSqlite } from "../../src/node/sqlite-policy.ts";
import { scratchDirectory } from "./support.ts";

await test("WAL, FULL synchronous, busy timeout, exclusive locking and truncating checkpoint work together", () => {
  const directory = scratchDirectory("sqlite-policy");
  const path = join(directory, "db.sqlite");
  const db = new DatabaseSync(path);
  try {
    configureSqlite(db);
    assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA synchronous").get()!.synchronous, 2);
    assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 1000);
    assert.equal(db.prepare("PRAGMA locking_mode").get()!.locking_mode, "exclusive");
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY); INSERT INTO entries VALUES (1)");
    assert.equal(checkpointSqlite(db).busy, 0);
    const competing = new DatabaseSync(path);
    try { assert.throws(() => competing.prepare("SELECT * FROM entries").all(), /locked/u); }
    finally { competing.close(); }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
