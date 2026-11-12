import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { NodeObservations } from "../../src/node/observations.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { initializeStore } from "../../src/observe/core/store.ts";
import { RETENTION_MS } from "../../src/observe/core/limits.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";
import { scratchDirectory } from "./support.ts";

const T = Date.UTC(2026, 10, 10);
const event = (service: string): ExternalEvent => ({ schemaVersion: 1, eventId: "same", atMs: T, operation: "save", outcome: "error", durationMs: 1, work: {}, release: "r1", service, error: { code: "db.timeout" } });

await test("service stores isolate derived state and artifacts, preserve resolutions on migration, and expire while idle after restart", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = scratchDirectory("observe-isolation");
  const path = join(directory, "stats.sqlite");
  const legacy = new DatabaseSync(path);
  const sql = nodeSqlScopes(legacy).open();
  initializeStore(sql);
  let now = T;
  const clock = { now: () => now };
  const old = createObserveService(sql, { now: clock.now, databaseBytes: () => 0 });
  await old.ingestExternal("alpha", [event("alpha")]);
  const fingerprint = (await old.issues({})).items[0]!.fingerprint;
  await old.setIssueState(fingerprint, "resolved");
  let registry = new NodeObservations(legacy, path, clock);
  try {
    const alpha = registry.forService("alpha"), beta = registry.forService("beta");
    assert.equal((await alpha.issue(fingerprint))!.state, "resolved");
    assert.deepEqual((await beta.issues({})).items, []);
    assert.equal(await beta.setIssueState(fingerprint, "resolved"), false);
    await beta.ingestExternal("beta", [event("beta")]);
    assert.notEqual((await beta.issues({})).items[0]!.fingerprint, fingerprint);
    const artifact = { version: "v1", file: "index.js", map: JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }) };
    assert.deepEqual(await alpha.artifact(artifact), { result: "accepted" });
    assert.deepEqual(await beta.artifact({ ...artifact, map: artifact.map.replace('"names":[]', '"names":["other"]') }), { result: "accepted" });
    assert.deepEqual(await alpha.artifact(artifact), { result: "duplicate" });
    assert.equal((await alpha.external("alpha", {})).length, 1);
    assert.equal((await beta.external("beta", {})).length, 1);
    assert.throws(() => registry.forService("../alpha"), RangeError);
    registry.close();
    registry = new NodeObservations(legacy, path, clock);
    assert.equal((await registry.forService("alpha").issue(fingerprint))!.state, "resolved");
    now += RETENTION_MS + 1;
    t.mock.timers.tick(3_600_000);
    registry.close();
    for (const service of ["alpha", "beta"]) {
      const db = new DatabaseSync(join(`${path}.observe`, `${service}.sqlite`));
      for (const table of ["observe_external_events", "observe_occurrences", "observe_issues", "observe_ingest_windows"]) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"], 0, `${service} ${table}`);
      }
      db.close();
    }
    assert.equal(sql.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_external_events")[0]!.n, 1);
  } finally {
    registry.close();
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("an interrupted legacy import rolls back and resumes without duplicating or guessing ownership", async () => {
  const directory = scratchDirectory("observe-migration");
  const path = join(directory, "stats.sqlite");
  const legacy = new DatabaseSync(path);
  const sql = nodeSqlScopes(legacy).open();
  initializeStore(sql);
  const old = createObserveService(sql, { now: () => T, databaseBytes: () => 0 });
  await old.ingestExternal("alpha", [event("alpha")]);
  const payload = sql.rows<{ payload: string }>("SELECT payload FROM observe_external_events")[0]!.payload;
  sql.run("UPDATE observe_external_events SET payload = 'invalid'");
  try {
    assert.throws(() => new NodeObservations(legacy, path, { now: () => T }), SyntaxError);
    const partial = new DatabaseSync(join(`${path}.observe`, "alpha.sqlite"));
    assert.equal(partial.prepare("SELECT COUNT(*) AS n FROM observe_external_events").get()!["n"], 0);
    partial.close();
    sql.run("UPDATE observe_external_events SET payload = ?", payload);
    const registry = new NodeObservations(legacy, path, { now: () => T });
    assert.equal((await registry.forService("alpha").external("alpha", {})).length, 1);
    assert.throws(() => registry.forService("alpha").external("beta", {}), RangeError);
    registry.close();
  } finally {
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
