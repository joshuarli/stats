import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/installation";

function stub(name: string) {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName(name));
}

function schemaVersion(state: DurableObjectState): number {
  return state.storage.sql.exec<{ version: number }>("SELECT version FROM schema_version LIMIT 1").one().version;
}

describe("schema migrations", () => {
  it("starts a fresh object at the current version", async () => {
    const version = await runInDurableObject(stub("migration-fresh"), async (_instance, state) => schemaVersion(state));
    expect(version).toBe(5);
  });

  it("adds host system details to an object already at the previous version without touching its hosts", async () => {
    await runInDurableObject(stub("migration-system"), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES ('h_0123456789abcdef0123456789abcdef', 'kept', 'hash', 1)");
      state.storage.sql.exec("DROP TABLE host_system");
      state.storage.sql.exec("UPDATE schema_version SET version = 2");
      migrate(state.storage);
      expect(schemaVersion(state)).toBe(5);
      expect(state.storage.sql.exec("SELECT name FROM hosts").toArray()).toEqual([{ name: "kept" }]);
      expect(state.storage.sql.exec("SELECT count(*) AS total FROM host_system").one().total).toBe(0);
    });
  });

  it("adds the project tables to a version 3 object keeping its hosts and samples", async () => {
    await runInDurableObject(stub("migration-projects"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES ('h_0123456789abcdef0123456789abcdef', 'kept', 'hash', 1)");
      sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, payload) VALUES ('h_0123456789abcdef0123456789abcdef', 'boot', '1', 1, 1, 1, 0, '{}')");
      sql.exec("DROP TABLE project_samples");
      sql.exec("DROP TABLE project_hours");
      sql.exec("DROP TABLE collector_runs");
      sql.exec("UPDATE schema_version SET version = 3");
      migrate(state.storage);
      expect(schemaVersion(state)).toBe(5);
      expect(sql.exec("SELECT name FROM hosts").toArray()).toEqual([{ name: "kept" }]);
      expect(sql.exec("SELECT count(*) AS total FROM samples").one().total).toBe(1);
      const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_samples', 'project_hours', 'collector_runs')").toArray().map(row => row.name).sort();
      expect(tables).toEqual(["collector_runs", "project_hours", "project_samples"]);
    });
  });

  it("drops project history that was weighted by the mismatched sample interval and keeps every other metric", async () => {
    await runInDurableObject(stub("migration-weighted"), async (_instance, state) => {
      const sql = state.storage.sql;
      const before = 1793565000000;
      const after = 1793566000000;
      const metrics = ["worker.invocations", "worker.status.2xx", "worker.cpuMsMax", "route.GET /x.invocations", "r2.stuff-mynpm.ops.success", "r2.stuff-mynpm.storageBytes", "d1.queries", "d1.rowsWritten", "d1q.UPDATE t.rowsRead", "do.invocations", "probe.site.up"];
      for (const metric of metrics) {
        for (const at of [before, after]) {
          sql.exec("INSERT INTO project_samples (project, metric, bucket_ms, value) VALUES ('p', ?, ?, 1)", metric, at);
          sql.exec("INSERT INTO project_hours (project, metric, hour_ms, value) VALUES ('p', ?, ?, 1)", metric, at);
        }
      }
      sql.exec("UPDATE schema_version SET version = 4");
      migrate(state.storage);
      const kept = (table: string, column: string, at: number) =>
        sql.exec<{ metric: string }>(`SELECT metric FROM ${table} WHERE ${column} = ? ORDER BY metric`, at).toArray().map(row => row.metric);
      for (const [table, column] of [["project_samples", "bucket_ms"], ["project_hours", "hour_ms"]] as const) {
        expect(kept(table, column, before)).toEqual(["do.invocations", "probe.site.up", "r2.stuff-mynpm.storageBytes", "worker.cpuMsMax"]);
        expect(kept(table, column, after)).toHaveLength(metrics.length);
      }
    });
  });

  it("applies missing migrations to an object created with the previous schema", async () => {
    await runInDurableObject(stub("migration-upgrade"), async (_instance, state) => {
      const indexes = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").toArray();
      expect(indexes.map(row => row.name)).toContain("rollups_by_expiry");
      state.storage.sql.exec("DROP TABLE rollups");
      state.storage.sql.exec("DROP INDEX samples_by_received");
      state.storage.sql.exec("UPDATE schema_version SET version = 0");
      migrate(state.storage);
      expect(schemaVersion(state)).toBe(5);
      const objects = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('rollups', 'samples_by_received', 'rollups_by_expiry')").toArray().map(row => row.name).sort();
      expect(objects).toEqual(["rollups", "rollups_by_expiry", "samples_by_received"]);
    });
  });
});
