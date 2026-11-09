import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/installation/schema";
import { readMetricHistory } from "../src/projects/history";
import { CloudflareSql } from "../src/cloudflare/sql";

function stub(name: string) {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName(name));
}

function schemaVersion(state: DurableObjectState): number {
  return state.storage.sql.exec<{ version: number }>("SELECT version FROM schema_version LIMIT 1").one().version;
}

describe("schema migrations", () => {
  it("starts a fresh object at the current version", async () => {
    const version = await runInDurableObject(stub("migration-fresh"), async (_instance, state) => schemaVersion(state));
    expect(version).toBe(10);
  });

  it("adds host system details to an object already at the previous version without touching its hosts", async () => {
    await runInDurableObject(stub("migration-system"), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES ('h_0123456789abcdef0123456789abcdef', 'kept', 'hash', 1)");
      state.storage.sql.exec("DROP TABLE host_system");
      state.storage.sql.exec("UPDATE schema_version SET version = 2");
      migrate(new CloudflareSql(state.storage));
      expect(schemaVersion(state)).toBe(10);
      expect(state.storage.sql.exec("SELECT name FROM hosts").toArray()).toEqual([{ name: "kept" }]);
      expect(state.storage.sql.exec("SELECT version FROM host_history_versions").toArray()).toEqual([{ version: 0 }]);
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
      migrate(new CloudflareSql(state.storage));
      expect(schemaVersion(state)).toBe(10);
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
      migrate(new CloudflareSql(state.storage));
      const kept = (table: string, column: string, at: number) =>
        sql.exec<{ metric: string }>(`SELECT metric FROM ${table} WHERE ${column} = ? ORDER BY metric`, at).toArray().map(row => row.metric);
      for (const [table, column] of [["project_samples", "bucket_ms"], ["project_hours", "hour_ms"]] as const) {
        expect(kept(table, column, before)).toEqual(["do.invocations", "probe.site.up", "r2.stuff-mynpm.storageBytes", "worker.cpuMsMax"]);
        expect(kept(table, column, after)).toHaveLength(metrics.length);
      }
    });
  });

  it("reports purged project history as unknown instead of filling it with zero", async () => {
    await runInDurableObject(stub("migration-unknown"), async (_instance, state) => {
      const sql = state.storage.sql;
      const project = { id: "p", name: "p", worker: "p", workerBilling: "requests-and-cpu" as const, buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] };
      const now = 1793572200000;
      const purgedBucket = 1793563800000;
      sql.exec("INSERT INTO collector_runs (at_ms, ok, detail, rows_read, duration_ms) VALUES (1793567500000, 1, 'ok', 1, 1)");
      sql.exec("INSERT INTO collector_runs (at_ms, ok, detail, rows_read, duration_ms) VALUES (1793571349204, 1, 'ok', 1, 1)");
      sql.exec("UPDATE schema_version SET version = 5");
      const valueAt = () => {
        const history = readMetricHistory(new CloudflareSql(state.storage), project, { range: "6h" }, "worker", now);
        const invocations = history.series.find(series => series.metric === "worker.invocations");
        return invocations?.values[(purgedBucket - history.fromMs) / 300000];
      };
      expect(valueAt()).toBe(0);
      migrate(new CloudflareSql(state.storage));
      expect(valueAt()).toBeNull();
      expect(sql.exec("SELECT count(*) AS total FROM collector_runs").one().total).toBe(1);
    });
  });

  it("applies missing migrations to an object created with the previous schema", async () => {
    await runInDurableObject(stub("migration-upgrade"), async (_instance, state) => {
      const indexes = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").toArray();
      expect(indexes.map(row => row.name)).toContain("rollups_by_expiry");
      state.storage.sql.exec("DROP TABLE rollups");
      state.storage.sql.exec("DROP INDEX samples_by_received");
      state.storage.sql.exec("UPDATE schema_version SET version = 0");
      migrate(new CloudflareSql(state.storage));
      expect(schemaVersion(state)).toBe(10);
      const objects = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('rollups', 'samples_by_received', 'rollups_by_expiry')").toArray().map(row => row.name).sort();
      expect(objects).toEqual(["rollups", "rollups_by_expiry", "samples_by_received"]);
    });
  });

  it("adds the service tables to a version 7 object without touching its hosts", async () => {
    await runInDurableObject(stub("migration-services"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES ('h_0123456789abcdef0123456789abcdef', 'kept', 'hash', 1)");
      sql.exec("DROP TABLE service_deployments");
      sql.exec("DROP TABLE services");
      sql.exec("UPDATE schema_version SET version = 7");
      migrate(new CloudflareSql(state.storage));
      expect(schemaVersion(state)).toBe(10);
      expect(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('services', 'service_deployments') ORDER BY name").toArray().map(row => row.name)).toEqual(["service_deployments", "services"]);
      expect(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('services') WHERE name = 'ingest_token_hash'").toArray()).toEqual([{ name: "ingest_token_hash" }]);
      expect(sql.exec("SELECT host_id, name, token_hash FROM hosts").toArray()).toEqual([{ host_id: "h_0123456789abcdef0123456789abcdef", name: "kept", token_hash: "hash" }]);
    });
  });

  it("adds the ingestion verifier to a version 8 service without changing its deploy verifier", async () => {
    await runInDurableObject(stub("migration-ingest"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE services");
      sql.exec(`CREATE TABLE services (
        name TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        host_ids TEXT NOT NULL,
        health_url TEXT,
        unit TEXT,
        created_at_ms INTEGER NOT NULL
      ) STRICT`);
      sql.exec("INSERT INTO services (name, token_hash, host_ids, health_url, unit, created_at_ms) VALUES ('legacy', 'deploy-verifier', '[]', NULL, NULL, 1)");
      sql.exec("UPDATE schema_version SET version = 8");
      expect(() => sql.exec("SELECT ingest_token_hash FROM services")).toThrow(/no such column/u);
      migrate(new CloudflareSql(state.storage));
      expect(schemaVersion(state)).toBe(10);
      expect(sql.exec("SELECT name, token_hash, ingest_token_hash FROM services").toArray()).toEqual([{ name: "legacy", token_hash: "deploy-verifier", ingest_token_hash: null }]);
    });
  });

  it("adds the pending hour table to a version 9 object keeping its hour rollups", async () => {
    await runInDurableObject(stub("migration-pending-hours"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES ('h_0123456789abcdef0123456789abcdef', '1h', 3600000, 0, 1, '{}')");
      sql.exec("DROP TABLE rollup_pending_hours");
      sql.exec("UPDATE schema_version SET version = 9");
      migrate(new CloudflareSql(state.storage));
      expect(schemaVersion(state)).toBe(10);
      expect(sql.exec("SELECT count(*) AS total FROM rollup_pending_hours").one().total).toBe(0);
      expect(sql.exec("SELECT resolution, bucket_ms FROM rollups").toArray()).toEqual([{ resolution: "1h", bucket_ms: 3600000 }]);
    });
  });
});
