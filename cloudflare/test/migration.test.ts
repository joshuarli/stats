import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/installation";

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

function schemaVersion(state: DurableObjectState): number {
  return state.storage.sql.exec<{ version: number }>("SELECT version FROM schema_version LIMIT 1").one().version;
}

describe("schema migrations", () => {
  it("starts a fresh object at the current version", async () => {
    const version = await runInDurableObject(stub(), async (_instance, state) => schemaVersion(state));
    expect(version).toBe(1);
  });

  it("applies missing migrations to an object created with the previous schema", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec("DROP TABLE rollups");
      state.storage.sql.exec("UPDATE schema_version SET version = 0");
      migrate(state.storage);
      expect(schemaVersion(state)).toBe(1);
      const table = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollups'").toArray();
      expect(table).toHaveLength(1);
    });
  });
});
