import test from "node:test";
import assert from "node:assert/strict";
import { reduceTailItem, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { POLICIES } from "../../src/observe/cloudflare/policies.ts";
import { errorReport } from "../../src/observe/producer/report.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";

const VERSION = "3172128e-5c58-48a4-8c16-7767d5521979";
const OBJECT = "71437be8483ec4c778560417396a6e8e81f1673f27ec5d341ec7a2645e467eb9";
const MARK = { channel: OBSERVE_CHANNEL, message: { kind: "invocation", traceId: "7bcf42a3d155dee9563e537e144790e4", spanId: "1b1e95b0d4dcde81" } };
const SECRET_HEADERS = { authorization: "REDACTED", cookie: "REDACTED", "cf-access-jwt-assertion": "REDACTED", "cf-connecting-ip": "157.131.72.123", "x-real-ip": "157.131.72.123" };

function fetchItem(url: string, status: number | null, overrides: Partial<TailItem> = {}): TailItem {
  return {
    event: { request: { url, method: url.includes("ingest") ? "POST" : "GET", headers: SECRET_HEADERS }, ...(status === null ? {} : { response: { status } }) },
    eventTimestamp: 1_793_750_714_539, exceptions: [], diagnosticsChannelEvents: [MARK], scriptVersion: { id: VERSION },
    executionModel: "stateless", outcome: "ok", cpuTime: 1, wallTime: 212, ...overrides
  };
}

function objectItem(event: unknown, overrides: Partial<TailItem> = {}): TailItem {
  return { ...fetchItem("https://installation/ingest", 200), event, executionModel: "durableObject", durableObjectId: OBJECT, entrypoint: "Installation", ...overrides };
}

function label(item: TailItem, policy = POLICIES.stats): string | null {
  const reduction = reduceTailItem(item, policy);
  return reduction.kind === "observed" ? reduction.invocation.label : reduction.kind;
}

await test("worker routes become low-cardinality templates", () => {
  assert.equal(label(fetchItem("https://stats.example/ingest/v2/batches?token=SECRET_IN_QUERY", 200)), "POST /ingest/v2/batches");
  assert.equal(label(fetchItem("https://stats.example/ingest/v1/batches?token=SECRET_IN_QUERY", 410)), "POST /ingest/v1/batches");
  assert.equal(label(fetchItem(`https://stats.example/api/v1/hosts/h_${"a".repeat(32)}/history?range=1h`, 200)), "GET /api/v1/hosts/:host/history");
  assert.equal(label(fetchItem("https://stats.example/api/v1/projects/stuff/deployments/0b5b2c1e-0f0a-4c4a-9d8e-1a2b3c4d5e6f/comparison", 200)), "GET /api/v1/projects/:project/deployments/:id/comparison");
});

await test("health, assets, the observability API, and unauthorized or unmatched requests are excluded", () => {
  for (const item of [
    fetchItem("https://stats.example/health", 200),
    fetchItem("https://stats.example/assets/index-abc.js", 200),
    fetchItem("https://stats.example/", 200),
    fetchItem("https://stats.example/api/observe/traces", 200),
    fetchItem("https://stats.example/ingest/v1/batches", 401),
    fetchItem("https://stats.example/api/v1/hosts", 403),
    fetchItem("https://stats.example/api/v1/nope", 404)
  ]) assert.equal(label(item), "excluded", JSON.stringify(item.event));
});

await test("usr-memories routes keep only its known path segments, so digests and memory ids never become labels", () => {
  const memories = POLICIES["usr-memories"];
  const digest = "b".repeat(64);
  assert.equal(label(fetchItem(`https://memories.example/api/v1/sync/objects/${digest}?origin=SECRET_IN_QUERY`, 200), memories), "GET /api/v1/sync/objects/:id");
  assert.equal(label(fetchItem(`https://memories.example/api/v1/sync/manifests/${digest}`, 200), memories), "GET /api/v1/sync/manifests/:id");
  assert.equal(label(fetchItem("https://memories.example/m/project-name/1234", 200), memories), "GET /m/:id/:id");
  assert.equal(label(fetchItem("https://memories.example/api/v1/sync/learning/deltas", 200), memories), "GET /api/v1/sync/learning/deltas");
  assert.equal(label(fetchItem("https://memories.example/", 200), memories), "GET /");
  assert.equal(label(fetchItem("https://memories.example/api/v1/status", 403), memories), "excluded");
});

await test("each service accepts only its own error operations", () => {
  const report = (operation: string) => ({ channel: OBSERVE_CHANNEL, message: { kind: "error", operation, name: "Error", message: "", stack: null } });
  const memories = POLICIES["usr-memories"];
  assert.equal(label(fetchItem("https://memories.example/api/v1/status", 503, { diagnosticsChannelEvents: [MARK, report("request.route")] }), memories), "GET /api/v1/status");
  assert.equal(label(fetchItem("https://memories.example/api/v1/status", 503, { diagnosticsChannelEvents: [MARK, report("deployments.poll")] }), memories), "rejected");
  assert.equal(label(fetchItem("https://stats.example/api/v1/hosts", 200, { diagnosticsChannelEvents: [MARK, report("request.route")] })), "rejected");
});

await test("object fetch, RPC, alarm, and cron invocations get their own labels", () => {
  assert.equal(label(objectItem({ request: { url: "https://installation/ingest", method: "POST", headers: {} }, response: { status: 200 } })), "Installation POST /ingest");
  assert.equal(label(objectItem({ rpcMethod: "recordCollectorRun" })), "Installation.recordCollectorRun");
  assert.equal(label(objectItem({ scheduledTime: new Date(0) })), "Installation.alarm");
  assert.equal(label(fetchItem("", null, { event: { scheduledTime: 0, cron: "*/5 * * * *" } })), "scheduled */5 * * * *");
});

await test("a reduced invocation carries trace context, platform timing, and errors, and no request data", () => {
  const reduction = reduceTailItem(fetchItem("https://stats.example/ingest/v1/batches?token=SECRET_IN_QUERY", 500, {
    outcome: "ok",
    exceptions: [{ name: "TypeError", message: "cause b", stack: "    at failB (src/index.ts:15:13)" }],
    diagnosticsChannelEvents: [MARK, { channel: "other", message: { anything: true } }, { channel: OBSERVE_CHANNEL, message: errorReport("deployments.poll", new Error("http_500")) }]
  }), POLICIES.stats);
  assert.equal(reduction.kind, "observed");
  if (reduction.kind !== "observed") return;
  const invocation = reduction.invocation;
  assert.deepEqual(invocation.trace, { traceId: MARK.message.traceId, spanId: MARK.message.spanId });
  assert.deepEqual([invocation.status, invocation.cpuMs, invocation.wallMs, invocation.version], [500, 1, 212, VERSION]);
  assert.deepEqual(invocation.errors.map(error => [error.source, error.operation, error.name]), [["uncaught", null, "TypeError"], ["caught", "deployments.poll", "Error"]]);
  const serialized = JSON.stringify(invocation);
  for (const leaked of ["SECRET", "REDACTED", "157.131", "token="]) assert.ok(!serialized.includes(leaked), leaked);
});

await test("malformed events on the observe channel reject the invocation", () => {
  const bad = [
    { channel: OBSERVE_CHANNEL, message: { kind: "invocation", traceId: 7 } },
    { channel: OBSERVE_CHANNEL, message: { kind: "error", operation: "made.up", name: "Error", message: "", stack: null } },
    { channel: OBSERVE_CHANNEL, message: { kind: "other" } }
  ];
  for (const event of bad) assert.equal(label(fetchItem("https://stats.example/api/v1/hosts", 200, { diagnosticsChannelEvents: [event] })), "rejected");
  assert.equal(label(fetchItem("https://stats.example/api/v1/hosts", 200, { executionModel: "dispatch" })), "rejected");
  assert.equal(label(fetchItem("https://stats.example/api/v1/hosts", 200, { eventTimestamp: null })), "rejected");
  assert.equal(label(fetchItem("https://stats.example/api/v1/hosts", 200, { event: { queue: "q" } })), "rejected");
});

await test("error reports survive non-Error throws and throwing accessors", () => {
  assert.deepEqual(errorReport("projects.config", "plain string"), { kind: "error", operation: "projects.config", name: "string", message: "", stack: null });
  const hostile = new Error("x");
  Object.defineProperty(hostile, "message", { get() { throw new Error("accessor"); } });
  Object.defineProperty(hostile, "stack", { get() { throw new Error("accessor"); } });
  const report = errorReport("projects.config", hostile);
  assert.deepEqual([report.name, report.message, report.stack], ["Error", "", null]);
});
