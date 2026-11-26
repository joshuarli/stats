import assert from "node:assert/strict";
import test from "node:test";
import { handleStatsRequest, type StatsTarget } from "../../src/core/http.ts";
import { decodeBrowserJourney, type BrowserJourney, UI_JOURNEY_PATH } from "../../src/observe/application/journey.ts";
import { captureApplicationRequest } from "../../src/observe/application/http.ts";

const journey: BrowserJourney = { schemaVersion: 1, source: "range", range: "6h", cache: false, outcome: "ok", startedAtMs: Date.now(), durationMs: 1500, trace: { traceId: "1".repeat(32), spanId: "2".repeat(16) }, work: { fetch_us: 1_490_000, query_us: 1_400_000, render_us: 10_000 }, asset: "index-123.js", dropped: 0 };

await test("browser observations reject arbitrary fields, forged trace IDs and unbounded timings", () => {
  assert.deepEqual(decodeBrowserJourney(journey, Date.now()), journey);
  for (const patch of [{ release: "forged" }, { service: "other" }, { url: "secret" }, { source: { toString: null } }, { work: { sql: 1 } }, { work: { query_us: -1 } }, { work: { query_us: 1e15 } }, { work: { query_us: 1.5 } }, { trace: { ...journey.trace, traceId: "0".repeat(32) } }, { durationMs: Infinity }, { startedAtMs: 0 }, { asset: "https://private/?token=secret" }, { dropped: -1 }]) {
    assert.equal(decodeBrowserJourney({ ...journey, ...patch }, Date.now()), null);
  }
});

await test("browser admission requires auth, same-origin JSON and a bounded valid body", async () => {
  const admitted: BrowserJourney[] = [];
  const target: StatsTarget = {
    observeExports: false,
    capabilities: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true, infraMetrics: false },
    authorize: async request => request.headers.get("test-auth") === "yes" ? { ok: true } : { ok: false, status: 401, message: "unauthorized" },
    authorizeIngest: async () => false, serviceExists: async () => false,
    installation: async () => { throw new Error("browser telemetry must not enter Installation"); }, assets: async () => new Response(), observe: null,
    recordBrowserJourney: entry => { admitted.push(entry); }
  };
  const send = (body: unknown = journey, headers: Record<string, string> = {}, method = "POST") => handleStatsRequest(new Request(`https://stats${UI_JOURNEY_PATH}`, { method, headers: { "test-auth": "yes", "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), target);
  assert.equal((await send(journey, { "test-auth": "no" })).status, 401);
  assert.equal((await send(journey, { origin: "https://evil" })).status, 403);
  assert.equal((await send(journey, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send(journey, { "content-type": "text/plain" })).status, 415);
  assert.equal((await send("x".repeat(4096))).status, 413);
  assert.equal((await send({ ...journey, release: "injected" })).status, 400);
  assert.equal((await send(journey, {}, "GET")).status, 405);
  assert.deepEqual(admitted, []);
  const response = await send();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { admitted: true });
  assert.deepEqual(admitted, [journey]);
});

await test("browser transport is excluded from HTTP capture and cannot emit itself", async () => {
  let emissions = 0;
  const response = await captureApplicationRequest(new Request(`https://stats${UI_JOURNEY_PATH}`, { method: "POST" }), async () => new Response(null, { status: 202 }), { release: "test", now: Date.now, monotonic: () => performance.now(), post: async () => { emissions++; return true; } });
  assert.equal(response.status, 202);
  assert.equal(emissions, 0);
});
