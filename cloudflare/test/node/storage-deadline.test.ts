import assert from "node:assert/strict";
import test from "node:test";
import { handleStatsRequest, type StatsTarget } from "../../src/core/http.ts";

const routes: Record<string, () => Request> = {
  "the hosts API": () => new Request("https://stats.example/api/v1/hosts"),
  "the deploy marker route": () => new Request("https://stats.example/ingest/services/web/deployments", {
    method: "POST",
    headers: { authorization: `Bearer nft_${"a".repeat(43)}`, "content-type": "application/json" },
    body: JSON.stringify({ markerId: "m1", version: "v1" })
  })
};

for (const [route, request] of Object.entries(routes)) {
  await test(`${route} reports a depot deadline as unavailable`, async () => {
    let body: unknown = { group: "depot", code: "request_deadline_exceeded", message: "private upstream details" };
    const target: StatsTarget = {
      capabilities: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true, infraMetrics: false },
      authorize: async () => ({ ok: true }), authorizeIngest: async () => false, serviceExists: async () => false,
      installation: async () => Response.json(body, { status: 400 }),
      assets: async () => new Response(null, { status: 404 }), observe: null
    };
    for (const error of [body, { error: { code: "depot.request_deadline_exceeded", message: "other private details" } }]) {
      body = error;
      const unavailable = await handleStatsRequest(request(), target);
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get("Retry-After"), "5");
      assert.equal(unavailable.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await unavailable.json(), {
        error: { code: "storage_unavailable", message: "telemetry storage missed an upstream deadline" }
      });
    }
    body = { error: { code: "invalid_request", message: "invalid query" } };
    const rejected = await handleStatsRequest(request(), target);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), body);
  });
}
