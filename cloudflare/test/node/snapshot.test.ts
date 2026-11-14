import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { beginImport, exportManifest, exportPage, finishImport, importProgress, importRows, maintenanceState, setFence, SnapshotError, type ObjectManifest } from "../../src/core/export/snapshot.ts";
import { migrate } from "../../src/core/installation/schema.ts";
import type { SqlDatabase, SqlValue } from "../../src/core/sql.ts";
import { initializeStore } from "../../src/observe/core/store.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";

function installation(): SqlDatabase {
  const sql = nodeSqlScopes(new DatabaseSync(":memory:")).open();
  migrate(sql);
  return sql;
}

function seed(sql: SqlDatabase, hosts: number): void {
  for (let index = 0; index < hosts; index += 1) {
    const hostId = `h_${index.toString(16).padStart(32, "0")}`;
    sql.run("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)", hostId, `host-${index}`, `verifier-${index}`, 1_700_000_000_000 + index);
    for (let seq = 0; seq < 7; seq += 1) {
      sql.run("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, payload) VALUES (?, 'boot', ?, ?, ?, ?, 0, ?)", hostId, `${18446744073709551615n - BigInt(seq)}`, 1_700_000_000_000 + seq, 1_700_000_000_000 + seq, seq * 1000, JSON.stringify({ cpu: { total: "18446744073709551615" }, ratio: 0.1 + seq }));
    }
    sql.run("INSERT INTO rollup_pending_hours (host_id, hour_ms) VALUES (?, ?)", hostId, 1_699_999_200_000);
  }
}

function copy(source: SqlDatabase, target: SqlDatabase, manifest: ObjectManifest, pageRows: number, interruptAfter = Infinity): number {
  beginImport(target, manifest);
  let pages = 0;
  for (const table of manifest.tables) {
    let after: readonly SqlValue[] | null = null;
    let offset = importProgress(target).find(entry => entry.table === table.name)?.rows ?? 0;
    let sent = 0;
    for (;;) {
      const page = exportPage(source, table.name, after, pageRows);
      if (sent + page.rows.length > offset) {
        if (pages >= interruptAfter) return pages;
        importRows(target, table.name, sent, page.rows);
        pages += 1;
      }
      sent += page.rows.length;
      offset = Math.max(offset, sent);
      if (page.next === null) break;
      after = page.next;
    }
  }
  return pages;
}

await test("an installation export round-trips into a fresh object with exact rows, u64 text and checksums", () => {
  const source = installation();
  seed(source, 5);
  assert.throws(() => exportManifest(source, "installation", 1, null), (error: unknown) => error instanceof SnapshotError && error.code === "maintenance");
  setFence(source, true);
  const manifest = exportManifest(source, "installation", 1, 123);
  assert.equal(manifest.tables.find(table => table.name === "samples")?.rows, 35);
  assert.equal(manifest.tables.some(table => table.name === "schema_version"), false);
  const target = installation();
  copy(source, target, manifest, 4);
  assert.equal(maintenanceState(target), "importing");
  finishImport(target);
  assert.equal(maintenanceState(target), "open");
  for (const table of ["hosts", "samples", "rollup_pending_hours"]) {
    assert.deepEqual(target.rows(`SELECT * FROM ${table} ORDER BY 1, 2`), source.rows(`SELECT * FROM ${table} ORDER BY 1, 2`), table);
  }
  assert.equal(target.rows<{ seq: string }>("SELECT seq FROM samples ORDER BY seq DESC LIMIT 1")[0]?.seq, "18446744073709551615");
});

await test("an interrupted import resumes from its recorded progress, and replayed pages are no-ops", () => {
  const source = installation();
  seed(source, 4);
  setFence(source, true);
  const manifest = exportManifest(source, "installation", 1, null);
  const target = installation();
  const first = copy(source, target, manifest, 3, 5);
  assert.equal(first, 5);
  const progress = importProgress(target);
  assert.ok(progress.some(entry => entry.rows > 0));
  copy(source, target, manifest, 3);
  const samples = manifest.tables.find(table => table.name === "samples")!;
  const replay = exportPage(source, "samples", null, 3);
  assert.deepEqual(importRows(target, "samples", 0, replay.rows), { table: "samples", rows: samples.rows });
  finishImport(target);
  assert.equal(target.rows<{ n: number }>("SELECT COUNT(*) AS n FROM samples")[0]?.n, 28);
});

await test("import rejects non-empty targets, different schemas, gaps, and corrupted rows", () => {
  const source = installation();
  seed(source, 2);
  setFence(source, true);
  const manifest = exportManifest(source, "installation", 1, null);
  const occupied = installation();
  seed(occupied, 1);
  assert.throws(() => beginImport(occupied, manifest), (error: unknown) => error instanceof SnapshotError && error.code === "conflict");
  const observe = nodeSqlScopes(new DatabaseSync(":memory:")).open();
  initializeStore(observe);
  assert.throws(() => beginImport(observe, manifest), (error: unknown) => error instanceof SnapshotError && error.code === "incompatible");
  assert.throws(() => beginImport(installation(), { ...manifest, format: "stats-export/0" as never }), (error: unknown) => error instanceof SnapshotError && error.code === "incompatible");
  const target = installation();
  beginImport(target, manifest);
  assert.throws(() => importRows(target, "samples", 3, []), (error: unknown) => error instanceof SnapshotError && error.code === "conflict");
  assert.throws(() => beginImport(target, { ...manifest, exportedAtMs: 2 }), (error: unknown) => error instanceof SnapshotError && error.code === "conflict");
  for (const table of manifest.tables) {
    const page = exportPage(source, table.name, null, 2000);
    const rows = table.name === "samples" ? page.rows.map((row, index) => index === 0 ? row.map((value, column) => column === 8 ? `${String(value)} ` : value) : row) : page.rows;
    importRows(target, table.name, 0, rows);
  }
  assert.throws(() => finishImport(target), (error: unknown) => error instanceof SnapshotError && error.code === "integrity");
  assert.equal(maintenanceState(target), "importing");
});

await test("an observation store exports and imports through the same contract", () => {
  const source = nodeSqlScopes(new DatabaseSync(":memory:")).open();
  initializeStore(source);
  for (let index = 0; index < 120; index += 1) source.run("INSERT INTO observe_version_labels (version, label, message, updated_at) VALUES (?, ?, ?, ?)", `v${index}`, `label ${index}`, null, 1_700_000_000_000 + index);
  setFence(source, true);
  const manifest = exportManifest(source, "observe:stats", 1, null);
  const target = nodeSqlScopes(new DatabaseSync(":memory:")).open();
  initializeStore(target);
  copy(source, target, manifest, 50);
  finishImport(target);
  assert.deepEqual(target.rows("SELECT * FROM observe_version_labels ORDER BY version"), source.rows("SELECT * FROM observe_version_labels ORDER BY version"));
});
