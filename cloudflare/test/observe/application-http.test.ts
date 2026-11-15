import assert from "node:assert/strict";
import test from "node:test";
import { captureApplicationRequest } from "../../src/observe/application/http.ts";
import { decodeBatch } from "../../src/observe/ingest/codec.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";

await test("HTTP correlation retains only valid nonzero W3C trace identities", async () => {
  for (const [parent, valid] of [
    ["00-11111111111111111111111111111111-2222222222222222-00", true],
    ["00-00000000000000000000000000000000-2222222222222222-00", false],
    ["00-11111111111111111111111111111111-0000000000000000-00", false],
    ["secret-not-a-trace", false]
  ] as const) {
    const events: ExternalEvent[] = [], pending: Promise<unknown>[] = [];
    await captureApplicationRequest(new Request("https://stats/api/v1/capabilities", { headers: { traceparent: parent } }), async () => new Response("ok"), {
      release: "v1", now: () => 1_794_600_000_000, monotonic: () => 0,
      waitUntil: promise => pending.push(promise), post: async body => { events.push(...body.events); return true; }
    });
    await Promise.all(pending);
    assert.deepEqual(events[0]?.trace, valid ? { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" } : undefined);
    assert.doesNotMatch(JSON.stringify(events), /secret-not-a-trace/u);
  }
});

await test("HTTP events retain bounded routes, real status and monotonic wall time without request secrets", async () => {
  const events: ExternalEvent[] = [];
  const pending: Promise<unknown>[] = [];
  let monotonic = 50;
  const options = { release: "stats-abcdef123456", now: () => 1_794_600_000_000, monotonic: () => monotonic, waitUntil: (promise: Promise<unknown>) => pending.push(promise), post: async (body: { events: readonly ExternalEvent[] }) => { events.push(...body.events); return true; } };
  const response = await captureApplicationRequest(new Request("https://private.example/api/v1/hosts/h_secret/history?token=SECRET_QUERY", { headers: { authorization: "Bearer SECRET_TOKEN", cookie: "SECRET_COOKIE" } }), async () => { monotonic = 63.4; return new Response("SECRET_BODY", { status: 503 }); }, options);
  await Promise.all(pending);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "SECRET_BODY");
  assert.equal(events[0]?.operation, "http.get.hosts");
  assert.equal(events[0]?.durationMs, 13);
  assert.equal(events[0]?.outcome, "error");
  assert.deepEqual(events[0]?.work, { http_status: 503 });
  assert.equal(decodeBatch(JSON.stringify({ events }), { service: "stats", nowMs: options.now() }).ok, true);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|h_secret|private.example|cpuMs/);
  for (const suffix of ["/health", "/ingest/observe/v1/stats/batches"]) await captureApplicationRequest(new Request(`https://stats${suffix}`), async () => new Response(), options);
  await Promise.all(pending);
  assert.equal(events.length, 1);
});

await test("a thrown handler is recorded as 500 and telemetry delivery failures never reject request ownership", async () => {
  const pending: Promise<unknown>[] = [];
  const events: ExternalEvent[] = [];
  const failure = new Error("handler failure");
  const options = { release: "v1", now: () => 1_794_600_000_000, monotonic: () => 10, waitUntil: (promise: Promise<unknown>) => pending.push(promise), post: async (body: { events: readonly ExternalEvent[] }) => { events.push(...body.events); throw new Error("SECRET_URL"); } };
  await assert.rejects(captureApplicationRequest(new Request("https://stats/unknown-secret"), () => Promise.reject(failure), options), error => error === failure);
  await Promise.all(pending);
  assert.equal(events[0]?.operation, "http.get.other");
  assert.equal(events[0]?.work["http_status"], 500);
  assert.equal(events[0]?.outcome, "error");
  const response = await captureApplicationRequest(new Request("https://stats/"), async () => new Response("ok"), { ...options, post: () => { throw new Error("sync failure"); } });
  await Promise.all(pending);
  assert.equal(await response.text(), "ok");
});

await test("cancelled requests never manufacture an HTTP 500 response", async () => {
  const controller = new AbortController();
  const events: ExternalEvent[] = [];
  const pending: Promise<unknown>[] = [];
  const request = new Request("https://stats/api/v1/services/stats/deployments", { signal: controller.signal });
  await assert.rejects(captureApplicationRequest(request, async () => { controller.abort(); throw new Error("aborted"); }, { release: "v1", now: () => 1_794_600_000_000, monotonic: () => 10, waitUntil: promise => pending.push(promise), post: async body => { events.push(...body.events); return true; } }), /aborted/);
  await Promise.all(pending);
  assert.equal(events[0]?.outcome, "cancelled");
  assert.equal(events[0]?.work["http_status"], undefined);
});

await test("summary HTTP events carry only bounded same-request timing fields", async () => {
  const events: ExternalEvent[] = [], pending: Promise<unknown>[] = [];
  let monotonic = 0;
  const response = await captureApplicationRequest(new Request("https://stats/api/observe/stats/external/telemetry/summary?from=100&to=3600100&secret=SECRET"), async () => {
    monotonic = 150;
    return new Response("unchanged", { headers: { "Server-Timing": "app-dispatch;dur=140.000, app-store;dur=120.125, app-query;dur=37.000, app-issues;dur=7.000, app-read;dur=44.000, app-encode;dur=0.250, secret;dur=12, app-invalid;dur=900, app-query;dur=NaN" } });
  }, { release: "v1", now: () => 1_794_600_000_000, monotonic: () => monotonic, waitUntil: promise => pending.push(promise), post: async body => { events.push(...body.events); return true; } });
  await Promise.all(pending);
  assert.equal(await response.text(), "unchanged");
  assert.match(response.headers.get("Server-Timing")!, /app-total;dur=150\.000/u);
  assert.deepEqual(events[0]?.work, { http_status: 200, dispatch_us: 140000, store_us: 120125, query_us: 37000, issues_us: 7000, read_us: 44000, encode_us: 250, requested_window_ms: 3600000 });
  assert.doesNotMatch(JSON.stringify(events), /SECRET|secret|app-invalid|NaN/u);
  assert.equal(decodeBatch(JSON.stringify({ events }), { service: "stats", nowMs: 1_794_600_000_000 }).ok, true);
});
