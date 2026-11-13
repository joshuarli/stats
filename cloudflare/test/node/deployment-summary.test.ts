import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOYMENT_RETENTION_MS, type Deployment, type DeploymentHistory, type LatestDeployment } from "../../src/deployments/model.ts";
import { decodeServices } from "../../src/deployments/service-decode.ts";
import { openHarness, NOW_MS } from "./support.ts";

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
