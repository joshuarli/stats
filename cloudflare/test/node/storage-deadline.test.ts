import assert from "node:assert/strict";
import { test } from "node:test";
import { handleStatsRequest, type StatsTarget } from "../../src/core/http.ts";

await test("the hosts API reports a depot deadline as unavailable", async () => {
  let body: unknown = { group: "depot", code: "request_deadline_exceeded", message: "private upstream details" };
  const target: StatsTarget = {
    capabilities: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true },
    authorize: async () => ({ ok: true }), authorizeIngest: async () => false, serviceExists: async () => false,
    installation: async () => Response.json(body, { status: 400 }),
    assets: async () => new Response(null, { status: 404 }), observe: null
  };
  const fetchHosts = () => handleStatsRequest(new Request("https://stats.example/api/v1/hosts"), target);
  for (const error of [body, { error: { code: "depot.request_deadline_exceeded", message: "other private details" } }]) {
    body = error;
    const unavailable = await fetchHosts();
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("Retry-After"), "5");
    assert.equal(unavailable.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await unavailable.json(), {
      error: { code: "storage_unavailable", message: "telemetry storage missed an upstream deadline" }
    });
  }
  body = { error: { code: "invalid_request", message: "invalid query" } };
  const rejected = await fetchHosts();
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), body);
});
