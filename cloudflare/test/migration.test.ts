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
    expect(version).toBe(4);
  });

  it("adds host system details to an object already at the previous version without touching its hosts", async () => {
    await runInDurableObject(stub("migration-system"), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES ('h_0123456789abcdef0123456789abcdef', 'kept', 'hash', 1)");
      state.storage.sql.exec("DROP TABLE host_system");
      state.storage.sql.exec("UPDATE schema_version SET version = 2");
      migrate(state.storage);
      expect(schemaVersion(state)).toBe(4);
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
      expect(schemaVersion(state)).toBe(4);
      expect(sql.exec("SELECT name FROM hosts").toArray()).toEqual([{ name: "kept" }]);
      expect(sql.exec("SELECT count(*) AS total FROM samples").one().total).toBe(1);
      const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_samples', 'project_hours', 'collector_runs')").toArray().map(row => row.name).sort();
      expect(tables).toEqual(["collector_runs", "project_hours", "project_samples"]);
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
      expect(schemaVersion(state)).toBe(4);
      const objects = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('rollups', 'samples_by_received', 'rollups_by_expiry')").toArray().map(row => row.name).sort();
      expect(objects).toEqual(["rollups", "rollups_by_expiry", "samples_by_received"]);
    });
  });
});
