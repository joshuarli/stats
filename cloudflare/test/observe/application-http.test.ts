import assert from "node:assert/strict";
import test from "node:test";
import { captureApplicationRequest } from "../../src/observe/application/http.ts";
import { decodeBatch } from "../../src/observe/ingest/codec.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";

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
