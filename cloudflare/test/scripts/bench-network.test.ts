import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const modulePath = new URL("../../scripts/bench-network.mjs", import.meta.url).href;
type NetworkRecord = { path: string; kind: string; status: number; bytes: number };
const { createNetworkTracker, summarizeNetwork } = await import(modulePath) as {
  createNetworkTracker: (page: EventEmitter, base: string) => {
    waitForQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
    snapshot: () => NetworkRecord[];
  };
  summarizeNetwork: (records: NetworkRecord[]) => {
    requests: number;
    jsBytes: number;
    failedRequests: { path: string; status: number }[];
  };
};

await test("network measurements report failed requests and reject unfinished work", async () => {
  const page = new EventEmitter();
  const tracker = createNetworkTracker(page, "http://localhost:4174");
  const request = (path: string, status: number | null, body = "") => ({
    url: () => path.startsWith("http") ? path : `http://localhost:4174${path}`,
    method: () => "GET",
    response: async () => status === null ? null : {
      status: () => status,
      body: async () => new TextEncoder().encode(body)
    }
  });
  const success = request("/assets/app.js", 200, "code");
  const missing = request("/api/v1/projects/missing", 404, "missing");
  const failed = request("/api/observe/traces", null);
  const external = request("https://example.org/ignored", 500);
  for (const entry of [success, missing, failed, external]) page.emit("request", entry);
  page.emit("requestfinished", success);
  page.emit("requestfinished", missing);
  page.emit("requestfailed", failed);
  await tracker.waitForQuiet(0, 200);
  const summary = summarizeNetwork(tracker.snapshot());
  assert.equal(summary.requests, 3);
  assert.equal(summary.jsBytes, 4);
  assert.deepEqual(summary.failedRequests.sort((left, right) => left.path.localeCompare(right.path)), [
    { path: "/api/observe/traces", status: 0 },
    { path: "/api/v1/projects/missing", status: 404 }
  ]);
  const hanging = request("/api/v1/hosts", null);
  page.emit("request", hanging);
  await assert.rejects(tracker.waitForQuiet(0, 40), /Network did not become idle.*1 requests active/u);
});
