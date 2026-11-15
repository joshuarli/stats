import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOYMENT_RETENTION_MS, type Deployment, type DeploymentHistory, type LatestDeployment } from "../../src/deployments/model.ts";
import { decodeServices } from "../../src/deployments/service-decode.ts";
import { openHarness, NOW_MS } from "./support.ts";
import { listServicesWithDeployments } from "../../src/core/installation/services.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const marker = (n: number, atMs = NOW_MS): Deployment => ({ id: id(n), atMs, source: "marker", message: "release", deferred: false, versions: [{ id: `v${n}`, percentage: 100 }] });

await test("service list summaries follow retained history including ties, expiry and failures", async () => {
  const harness = openHarness();
  try {
    harness.db.prepare("INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run("web", "hash", "hash2", "[]", null, null, NOW_MS);
    const list = async () => {
      const response = await harness.core.fetch(new Request("https://installation/services"));
      assert.equal(response.status, 200);
      return decodeServices(await response.json())[0]!.latestDeployment;
    };
    const history = async () => await (await harness.core.fetch(new Request("https://installation/services/web/deployments"))).json() as DeploymentHistory;
    assert.deepEqual(await list(), { status: "none" });
    const insert = harness.db.prepare("INSERT INTO service_deployments (service, marker_id, id, at_ms, host_ids, payload) VALUES (?, ?, ?, ?, ?, ?)");
    const first = marker(1);
    insert.run("web", "m1", first.id, first.atMs, "[]", JSON.stringify(first));
    assert.deepEqual(await list(), { status: "available", deployment: (await history()).deployments[0], versions: [] });
    const second = marker(2);
    insert.run("web", "m2", second.id, second.atMs, "[]", JSON.stringify(second));
    assert.deepEqual(await list(), { status: "available", deployment: (await history()).deployments[0], versions: [] });
    harness.setNow(NOW_MS + DEPLOYMENT_RETENTION_MS + 1);
    assert.deepEqual(await list(), { status: "none" });
    harness.setNow(NOW_MS);
    harness.db.prepare("UPDATE service_deployments SET payload = ? WHERE marker_id = ?").run("invalid", "m2");
    assert.deepEqual(await list(), { status: "unavailable" });
  } finally { harness.close(); }
});

await test("service list at the marker cap returns one bounded summary", async () => {
  const harness = openHarness();
  try {
    harness.db.prepare("INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run("web", "hash", "hash2", "[]", null, null, NOW_MS);
    const insert = harness.db.prepare("INSERT INTO service_deployments (service, marker_id, id, at_ms, host_ids, payload) VALUES (?, ?, ?, ?, ?, ?)");
    harness.db.exec("BEGIN");
    for (let n = 1; n <= 1000; n += 1) { const value = marker(n, NOW_MS - n); insert.run("web", `m${n}`, value.id, value.atMs, "[]", JSON.stringify(value)); }
    harness.db.exec("COMMIT");
    const response = await harness.core.fetch(new Request("https://installation/services"));
    const body = await response.text();
    assert.ok(new TextEncoder().encode(body).length < 1000);
    const summary: LatestDeployment | undefined = decodeServices(JSON.parse(body))[0]!.latestDeployment;
    assert.equal(summary?.status, "available");
    if (summary?.status !== "available") throw new Error("missing summary");
    assert.equal(summary.deployment.id, id(1));
    assert.equal(summary.versions.length, 0);
  } finally { harness.close(); }
});

await test("service catalog reads once and isolates invalid deployment payloads", async () => {
  const harness = openHarness();
  try {
    const insertService = harness.db.prepare("INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const name of ["bad", "good", "old"]) insertService.run(name, "secret-deploy-hash", "secret-ingest-hash", "[]", null, null, NOW_MS);
    const insert = harness.db.prepare("INSERT INTO service_deployments (service, marker_id, id, at_ms, host_ids, payload) VALUES (?, ?, ?, ?, ?, ?)");
    const retained = marker(3, NOW_MS - DEPLOYMENT_RETENTION_MS);
    insert.run("good", "retained", retained.id, retained.atMs, "[]", JSON.stringify(retained));
    insert.run("bad", "bad", id(4), NOW_MS, "[]", "invalid");
    insert.run("old", "old", id(5), NOW_MS - DEPLOYMENT_RETENTION_MS - 1, "[]", JSON.stringify(marker(5)));
    const sql = nodeSqlScopes(harness.db).open();
    const before = sql.total().statements;
    const errors: unknown[] = [];
    const services = listServicesWithDeployments(sql, NOW_MS, error => errors.push(error));
    assert.equal(sql.total().statements - before, 1);
    assert.equal(errors.length, 1);
    assert.deepEqual(services.map(service => service.latestDeployment), [
      { status: "unavailable" },
      { status: "available", deployment: retained, versions: [] },
      { status: "none" },
    ]);
    const response = await harness.core.fetch(new Request("https://installation/services"));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.deepEqual(decodeServices(JSON.parse(body)).map(service => service.latestDeployment), services.map(service => service.latestDeployment));
    assert.ok(!body.includes("secret-deploy-hash"));
    assert.ok(!body.includes("secret-ingest-hash"));
  } finally { harness.close(); }
});

await test("service catalog remains available when deployment history is absent", async () => {
  const harness = openHarness();
  try {
    const insert = harness.db.prepare("INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("alpha", "secret-a", "secret-b", "[]", null, null, NOW_MS);
    insert.run("beta", "secret-c", "secret-d", "[]", null, null, NOW_MS);
    harness.db.exec("DROP TABLE service_deployments");
    const response = await harness.core.fetch(new Request("https://installation/services"));
    assert.equal(response.status, 200);
    const body = await response.text();
    const services = decodeServices(JSON.parse(body));
    assert.deepEqual(services.map(service => [service.name, service.latestDeployment]), [["alpha", { status: "unavailable" }], ["beta", { status: "unavailable" }]]);
    assert.ok(!body.includes("secret-"));
  } finally { harness.close(); }
});
