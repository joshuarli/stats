import test from "node:test";
import assert from "node:assert/strict";
import { reduceTailItem, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { POLICIES } from "../../src/observe/core/policies.ts";
import { errorReport } from "../../src/observe/producer/report.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";
import { NANOSHOP_OPERATIONS, NANOSHOP_ROUTES, NANOSHOP_RPC_METHODS } from "../../src/observe/core/nanoshop-policy.ts";
import { groupByService, isObservedService, OBSERVED_SERVICES } from "../../src/observe/services.ts";

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
  assert.equal(label(fetchItem("https://stats.example/ingest/services/any-name/deployments", 201)), "POST /ingest/services/:service/deployments");
  assert.equal(label(fetchItem("https://stats.example/api/v1/services/any-name/deployments", 200)), "GET /api/v1/services/:service/deployments");
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

await test("nanoshop-storied routes are templates generated from its route list, and assets and unmatched paths are excluded", () => {
  const shop = POLICIES["nanoshop-storied"];
  const cases: readonly [string, string][] = [
    ["https://shop.example/", "GET /"],
    ["https://shop.example/products?q=SECRET_IN_QUERY", "GET /products"],
    ["https://shop.example/products/linen-shirt", "GET /products/:handle"],
    ["https://shop.example/collections", "GET /collections"],
    ["https://shop.example/collections/new-in", "GET /collections/:handle"],
    ["https://shop.example/search?q=SECRET_IN_QUERY", "GET /search"],
    ["https://shop.example/cart", "GET /cart"],
    ["https://shop.example/cart/items", "GET /cart/items"],
    ["https://shop.example/cart/items/9007199254740993", "GET /cart/items/:variant_id"],
    ["https://shop.example/cart/items/9007199254740993/remove", "GET /cart/items/:variant_id/remove"]
  ];
  for (const [url, expected] of cases) assert.equal(label(fetchItem(url, 200), shop), expected, url);
  for (const url of [
    "https://shop.example/static/app.css", "https://shop.example/assets/hero.webp", "https://shop.example/static", "https://shop.example/products/a/b",
    "https://shop.example/products/", "https://shop.example/cart/items/1/remove/x", "https://shop.example/cart/", "https://shop.example/wp-login.php"
  ]) assert.equal(label(fetchItem(url, 200), shop), "excluded", url);
});

await test("nanoshop-storied operations come from its route and RPC lists", () => {
  assert.deepEqual([...NANOSHOP_OPERATIONS].sort(), [
    ...NANOSHOP_ROUTES.map(route => `request.${route.name}`),
    "request.unmatched", "catalog.load", "catalog.rejected",
    ...NANOSHOP_RPC_METHODS.map(method => `store.rpc.${method}`),
    "store.alarm", "payment.unknown", "payment.blocked", "work.dead", "inventory.invariant", "email.failed", "provider.error"
  ].sort());
  assert.equal(new Set(NANOSHOP_OPERATIONS).size, NANOSHOP_OPERATIONS.length);
  for (const operation of ["store.rpc.commerceCommand", "store.rpc.commerceQuery", "request.webhook", "request.admin-order-refund", "request.checkout-attempt"]) assert.ok(NANOSHOP_OPERATIONS.includes(operation as never), operation);
});

await test("nanoshop commerce, order, shop, admin, and webhook routes are templates, and tokens and references are never stored", () => {
  const shop = POLICIES["nanoshop-storied"];
  const post = (url: string) => label(fetchItem(url, 200, { event: { request: { url, method: "POST", headers: SECRET_HEADERS }, response: { status: 200 } } }), shop);
  const cases: readonly [string, string][] = [
    ["https://shop.example/checkout", "GET /checkout"],
    ["https://shop.example/checkout/quotes/Q-SECRET-REF/accept", "GET /checkout/quotes/:ref/accept"],
    ["https://shop.example/checkout/attempts/A-SECRET-REF", "GET /checkout/attempts/:ref"],
    ["https://shop.example/orders/lookup", "GET /orders/lookup"],
    ["https://shop.example/orders/SO-1001", "GET /orders/:number"],
    ["https://shop.example/orders/access/SECRET_ACCESS_TOKEN", "GET /orders/access/:token"],
    ["https://shop.example/pages/shipping?x=SECRET_IN_QUERY", "GET /pages/:slug"],
    ["https://shop.example/sitemap.xml", "GET /sitemap.xml"],
    ["https://shop.example/robots.txt", "GET /robots.txt"],
    ["https://shop.example/admin", "GET /admin"],
    ["https://shop.example/admin/products/new", "GET /admin/products/new"],
    ["https://shop.example/admin/products/p_42", "GET /admin/products/:product_id"],
    ["https://shop.example/admin/orders/SO-1001/refunds", "GET /admin/orders/:number/refunds"],
    ["https://shop.example/admin/media/m1/file.jpg", "GET /admin/media/:media_id/:file"],
    ["https://shop.example/webhooks/stripe", "GET /webhooks/stripe"]
  ];
  for (const [url, expected] of cases) {
    const found = label(fetchItem(url, 200), shop);
    assert.equal(found, expected, url);
    assert.ok(!String(found).includes("SECRET"), url);
  }
  assert.equal(post("https://shop.example/webhooks/stripe"), "POST /webhooks/stripe");
  for (const url of ["https://shop.example/orders/access/a/b", "https://shop.example/checkout/attempts/", "https://shop.example/admin/orders/SO-1/unknown"]) assert.equal(label(fetchItem(url, 200), shop), "excluded", url);
  for (const route of NANOSHOP_ROUTES) {
    const url = `https://shop.example${route.pattern.replace(/\{[a-z_]+\}/gu, "x1")}`;
    const template = route.pattern.replace(/\{([a-z_]+)\}/gu, ":$1");
    assert.equal(label(fetchItem(url, 200), shop), `GET ${template}`, route.name);
  }
});

await test("nanoshop-storied accepts reports of its commerce operations and rejects another service's", () => {
  const shop = POLICIES["nanoshop-storied"];
  const report = (operation: string) => ({ channel: OBSERVE_CHANNEL, message: { kind: "error", operation, name: "Error", message: "", stack: null } });
  for (const operation of ["store.rpc.commerceCommand", "store.rpc.commerceQuery", "store.alarm", "payment.unknown", "payment.blocked", "work.dead", "inventory.invariant", "email.failed", "provider.error"]) {
    const reduction = reduceTailItem(fetchItem("https://shop.example/cart", 500, { diagnosticsChannelEvents: [MARK, report(operation)] }), shop);
    assert.equal(reduction.kind, "observed", operation);
    if (reduction.kind === "observed") assert.deepEqual(reduction.invocation.errors.map(error => error.operation), [operation]);
  }
  assert.equal(label(fetchItem("https://shop.example/cart", 500, { diagnosticsChannelEvents: [MARK, report("host.ingest")] }), shop), "rejected");
});

await test("the demo shops are observed services with the same policy as nanoshop-storied", () => {
  for (const service of ["nanoshop-fieldhouse", "nanoshop-tidewater"] as const) {
    assert.ok(isObservedService(service), service);
    const demo = POLICIES[service];
    const storied = POLICIES["nanoshop-storied"];
    assert.equal(demo.workerRoute, storied.workerRoute, service);
    assert.equal(demo.objectRoute("/anything"), null, service);
    assert.deepEqual([demo.operations, demo.operationMessages, demo.sampling], [storied.operations, storied.operationMessages, storied.sampling], service);
    const { byService, unknown } = groupByService([{ scriptName: service }]);
    assert.deepEqual([[...byService.keys()], unknown.length], [[service], 0]);
  }
  assert.equal(isObservedService("nanoshop-evil"), false);
});

await test("nanoshop-storied labels its Durable Object RPCs, has no object route, and accepts only its own error operations", () => {
  const shop = POLICIES["nanoshop-storied"];
  assert.equal(label(objectItem({ rpcMethod: "readCart" }, { entrypoint: "TenantStore" }), shop), "TenantStore.readCart");
  assert.equal(label(objectItem({ request: { url: "https://tenant/anything", method: "GET", headers: {} }, response: { status: 200 } }, { entrypoint: "TenantStore" }), shop), "excluded");
  const report = (operation: string) => ({ channel: OBSERVE_CHANNEL, message: { kind: "error", operation, name: "Error", message: "", stack: null } });
  assert.equal(label(fetchItem("https://shop.example/cart", 500, { diagnosticsChannelEvents: [MARK, report("store.rpc.addToCart")] }), shop), "GET /cart");
  assert.equal(label(fetchItem("https://shop.example/cart", 500, { diagnosticsChannelEvents: [MARK, report("deployments.poll")] }), shop), "rejected");
});

await test("a producer can supply its own closed operation union", () => {
  type ShopOperation = "request.cart";
  const shop = errorReport<ShopOperation>("request.cart", new Error("x"));
  const operation: ShopOperation = shop.operation;
  assert.equal(operation, "request.cart");
});

await test("service identity comes only from the platform script name", () => {
  const forged = { url: "https://nanoshop-storied.example/cart", headers: { host: "nanoshop-storied", "x-script-name": "nanoshop-storied", "cf-worker": "nanoshop-storied" } };
  const claimed = { ...fetchItem(forged.url, 200), event: { request: { url: forged.url, method: "GET", headers: forged.headers } } };
  const { byService, unknown } = groupByService([
    { ...claimed, scriptName: "stats" },
    { ...claimed, scriptName: null },
    { ...claimed },
    { ...claimed, scriptName: "nanoshop-storied-evil" },
    { ...claimed, scriptName: "nanoshop-storied" }
  ]);
  assert.equal(unknown.length, 3);
  assert.deepEqual([...byService].map(([service, items]) => [service, items.length]), [["stats", 1], ["nanoshop-storied", 1]]);
  assert.deepEqual(OBSERVED_SERVICES, ["stats", "usr-memories", "nanoshop-storied", "nanoshop-fieldhouse", "nanoshop-tidewater"]);
});

const SHOP_SPAN = { traceId: "9bcf42a3d155dee9563e537e144790e4", spanId: "2b1e95b0d4dcde81" };

function serviceOperation(overrides: Record<string, unknown> = {}) {
  return { channel: OBSERVE_CHANNEL, message: { kind: "operation", ...SHOP_SPAN, operation: "request.cart", synthetic: false, rows: null, ...overrides } };
}

await test("a service other than stats carries its trace on a generic operation message and needs no invocation mark", () => {
  const shop = POLICIES["nanoshop-storied"];
  for (const rows of [null, { read: 1, written: 0, statements: 1 }]) {
    const reduction = reduceTailItem(fetchItem("https://shop.example/cart", 200, { diagnosticsChannelEvents: [serviceOperation({ rows })] }), shop);
    assert.equal(reduction.kind, "observed");
    if (reduction.kind === "observed") assert.deepEqual(reduction.invocation.trace, SHOP_SPAN);
  }
  for (const bad of [{ operation: "host.ingest" }, { operation: "deployments.poll" }, { rows: { read: 1 } }, { rows: { read: -1, written: 0, statements: 0 } }, { synthetic: "no" }, { traceId: 1 }]) {
    assert.equal(label(fetchItem("https://shop.example/cart", 200, { diagnosticsChannelEvents: [serviceOperation(bad)] }), shop), "rejected", JSON.stringify(bad));
  }
  assert.equal(label(fetchItem("https://shop.example/cart", 200, { diagnosticsChannelEvents: [serviceOperation(), serviceOperation()] }), shop), "rejected");
});

await test("stats keeps its typed operation decoder, and a generic message is not a stats operation", () => {
  const generic = serviceOperation({ operation: "host.ingest" });
  assert.equal(label(fetchItem("https://stats.example/ingest/v2/batches", 200, { diagnosticsChannelEvents: [generic] })), "rejected");
  const typed = { channel: OBSERVE_CHANNEL, message: { kind: "operation", ...SHOP_SPAN, operation: "deployments.poll", synthetic: false, rows: { read: 1, written: 0, statements: 1 } } };
  const reduction = reduceTailItem(fetchItem("https://stats.example/ingest/v2/batches", 200, { diagnosticsChannelEvents: [typed] }), POLICIES.stats);
  assert.equal(reduction.kind === "observed" ? reduction.invocation.operation?.operation : reduction.kind, "deployments.poll");
});

await test("an unrouted request that failed is observed as unmatched, and the rest stay excluded", () => {
  const report = { channel: OBSERVE_CHANNEL, message: { kind: "error", operation: "request.unmatched", name: "Error", message: "x", stack: null } };
  const shop = POLICIES["nanoshop-storied"];
  const caught = reduceTailItem(fetchItem("https://shop.example/static/x", 500, { diagnosticsChannelEvents: [MARK, report] }), shop);
  assert.equal(caught.kind, "observed");
  if (caught.kind === "observed") assert.deepEqual([caught.invocation.label, caught.invocation.status, caught.invocation.errors.map(error => error.source)], ["GET unmatched", 500, ["caught"]]);
  const uncaught = reduceTailItem(fetchItem("https://shop.example/static/x", 200, { exceptions: [{ name: "TypeError", message: "x" }] }), shop);
  assert.equal(uncaught.kind === "observed" ? uncaught.invocation.errors[0]?.source : uncaught.kind, "uncaught");
  assert.equal(label(fetchItem("https://shop.example/static/x", 503), shop), "GET unmatched");
  assert.equal(label(fetchItem("https://shop.example/static/x", 200, { diagnosticsChannelEvents: [MARK, report] }), shop), "GET unmatched");
  assert.equal(label(fetchItem("https://shop.example/static/x", 200), shop), "excluded");
  assert.equal(label(fetchItem("https://shop.example/static/x", 499), shop), "excluded");
  assert.equal(label(fetchItem("https://shop.example/static/x", 404, { exceptions: [{ name: "TypeError", message: "x" }] }), shop), "excluded");
  assert.equal(label(fetchItem("https://stats.example/nowhere", 500, { diagnosticsChannelEvents: [MARK] })), "GET unmatched");
  assert.equal(label(objectItem({ request: { url: "https://installation/", method: "GET", headers: {} }, response: { status: 500 } })), "excluded");
});
