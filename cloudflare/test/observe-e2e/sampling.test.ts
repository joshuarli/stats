import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { collectorModules, ROOT, until, type Page, type TraceSummary } from "./harness.ts";
import { COUNT_FLUSH_INTERVAL_MS } from "../../src/observe/core/count-buffer.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";
import { NANOSHOP_SAMPLING } from "../../src/observe/cloudflare/nanoshop-policy.ts";
import type { Health, Exploration, ObjectMethods, StatsWindow } from "../../src/observe/core/store.ts";

const COMPAT = { compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat"] };
const SERVICE = "nanoshop-storied";

const PRODUCER = `
import { DurableObject, tracing } from "cloudflare:workers";
import diagnostics from "node:diagnostics_channel";
const channel = diagnostics.channel("stats.observe");
function mark(operation) {
  const span = tracing.getActiveSpan();
  if (span === undefined) return;
  const context = span.spanContext();
  channel.publish({ kind: "operation", traceId: context.traceId, spanId: context.spanId, operation, synthetic: false, rows: null });
}
export class TenantStore extends DurableObject {
  async addToCart() { mark("store.rpc.addToCart"); return { ok: true }; }
}
function objectNotSharedWithConcurrentRequests(env) { return env.STORE.getByName(crypto.randomUUID()); }
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/cart/items") { mark("request.cart-add"); await objectNotSharedWithConcurrentRequests(env).addToCart(); return Response.json({ ok: true }); }
    if (path === "/search") { mark("request.search"); return Response.json({ ok: true }); }
    if (path === "/cart") { mark("request.cart"); return new Response("unavailable", { status: 500 }); }
    return new Response("static");
  }
};`;

const SKEWED_COLLECTOR = `import collector, { ObservationStore } from "./index.js";
export { ObservationStore };
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
export default {
  ...collector,
  tail(events, env, ctx) { return collector.tail(events.map(event => ({ ...event, scriptName: event.scriptName ?? ${JSON.stringify(SERVICE)} })), env, ctx); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/clock-forward") { skewMs += Number(url.searchParams.get("ms")); return new Response("ok"); }
    return collector.fetch(request, env, ctx);
  }
};`;

interface Shop {
  readonly mf: Miniflare;
  send(path: string, method?: string): Promise<void>;
  observe<T>(path: string): Promise<T>;
  collectorClockForward(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

async function startShop(): Promise<Shop> {
  const persist = mkdtempSync(join(tmpdir(), "sampling-e2e-"));
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [
      { name: SERVICE, modules: true, script: PRODUCER, ...COMPAT, tails: ["stats-observe"], durableObjects: { STORE: { className: "TenantStore", useSQLite: true } } },
      {
        name: "stats-observe",
        modules: [{ type: "ESModule" as const, path: join(ROOT, "observe-worker/collector-entry.js"), contents: SKEWED_COLLECTOR }, collectorModules(SERVICE)[1]!],
        ...COMPAT, durableObjects: { STORE: { className: "ObservationStore", useSQLite: true } }
      }
    ] }),
    resourcePersistencePath: persist
  });
  const shop = await mf.getWorker(SERVICE);
  const collector = await mf.getWorker("stats-observe");
  return {
    mf,
    send: async (path, method = "GET") => { await (await shop.fetch(`https://shop.example${path}`, { method })).arrayBuffer(); },
    observe: async <T>(path: string) => await (await collector.fetch(`https://observe/${SERVICE}${path}`)).json() as T,
    collectorClockForward: async ms => { await (await collector.fetch(`https://observe/clock-forward?ms=${ms}`)).arrayBuffer(); },
    dispose: async () => { await mf.dispose(); rmSync(persist, { recursive: true, force: true }); }
  };
}

async function sendAll(shop: Shop, requests: readonly (readonly [string, string])[]): Promise<void> {
  for (let at = 0; at < requests.length; at += 50) await Promise.all(requests.slice(at, at + 50).map(([path, method]) => shop.send(path, method)));
}

await test("a sampled service is counted exactly, keeps a trace's Worker and Durable Object invocations together, and keeps every failure", async () => {
  const shop = await startShop();
  try {
    const carts = 1_000, searches = 1_000, failures = 20, assets = 20;
    const requests: (readonly [string, string])[] = [
      ...Array.from({ length: carts }, () => ["/cart/items", "POST"] as const),
      ...Array.from({ length: searches }, () => ["/search", "GET"] as const),
      ...Array.from({ length: failures }, () => ["/cart", "GET"] as const),
      ...Array.from({ length: assets }, () => ["/static/app.css", "GET"] as const)
    ];
    await sendAll(shop, requests);
    const events = 2 * carts + searches + failures + assets;
    await until(() => shop.observe<Health>("/health"), value => value.liveInvocations >= failures, "the failures");
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const beforeFlush = await shop.observe<Health>("/health");
    assert.ok((beforeFlush.sampling?.sampledOut ?? 0) === 0, "sampled-out counts wait in the tail isolate");
    assert.ok(beforeFlush.writes.ingestBatches < events / 20, `${beforeFlush.writes.ingestBatches} store calls for ${events} events`);

    let triggers = 0;
    let health = beforeFlush;
    const total = (value: Health) => (value.sampling?.kept ?? 0) + (value.sampling?.sampledOut ?? 0) + (value.sampling?.excluded ?? 0);
    while (total(health) !== events + triggers) {
      assert.ok(triggers < 5, `flushed ${total(health)} of ${events + triggers} events`);
      await shop.collectorClockForward(COUNT_FLUSH_INTERVAL_MS + 1_000);
      await shop.send("/cart");
      triggers++;
      health = await until(() => shop.observe<Health>("/health"), value => total(value) >= events + triggers, "the flush").catch(() => shop.observe<Health>("/health"));
    }
    const observedEvents = events - assets + triggers;
    const sampling = health.sampling!;
    assert.deepEqual([sampling.kept + sampling.sampledOut, sampling.excluded, sampling.untraced], [observedEvents, assets, 0]);
    assert.equal(health.liveInvocations, sampling.kept);
    assert.ok(sampling.kept < observedEvents / 10, `${sampling.kept} kept`);
    assert.deepEqual([sampling.policy.keepPerMillion, health.rejected], [NANOSHOP_SAMPLING.keepPerMillion, 0]);
    assert.ok(health.writes.ingestBatches < observedEvents / 20, `${health.writes.ingestBatches} store calls for ${observedEvents} events`);

    const bucket = Math.floor(Date.now() / COUNT_BUCKET_MS) * COUNT_BUCKET_MS;
    const window = await shop.observe<StatsWindow>(`/window?from=${bucket - COUNT_BUCKET_MS}&to=${bucket + 2 * COUNT_BUCKET_MS}`);
    assert.equal(window.invocations.reduce((sum, row) => sum + row.count, 0), observedEvents);
    assert.equal(window.outcomes.filter(row => row.outcome === "excluded-route").reduce((sum, row) => sum + row.count, 0), assets);
    assert.deepEqual(window.sampling, { keepPerMillion: NANOSHOP_SAMPLING.keepPerMillion, kept: sampling.kept, observed: observedEvents });

    const range = `from=${bucket - COUNT_BUCKET_MS}&to=${bucket + 2 * COUNT_BUCKET_MS}`;
    const explored = await shop.observe<Exploration>(`/explore?${range}`);
    const workerEvents = carts + searches + failures + triggers;
    assert.equal(explored.sampling?.observed, workerEvents);
    assert.equal(explored.routes.reduce((sum, route) => sum + route.requests, 0), explored.sampling?.kept);
    assert.deepEqual(Object.fromEntries(explored.routes.map(route => [route.label, route.observed])), { "GET /cart": failures + triggers, "GET /search": searches, "POST /cart/items": carts });
    const traces = await shop.observe<Page<TraceSummary> & { sampling?: { observed: number; kept: number } }>("/traces?limit=100");
    assert.deepEqual([traces.sampling?.observed, traces.sampling?.kept], [workerEvents, explored.sampling?.kept]);
    const objects = await shop.observe<ObjectMethods>(`/objects?${range}`);
    const keptCarts = explored.routes.find(route => route.label === "POST /cart/items");
    assert.ok(keptCarts !== undefined && keptCarts.requests > 0, "some cart requests are kept");
    assert.equal(objects.sampling?.observed, carts);
    assert.equal(objects.methods.find(method => method.label === "TenantStore.addToCart")?.requests, keptCarts.requests, "a kept cart request keeps its Durable Object invocation, and no other does");
    const failed = (await shop.observe<Page<TraceSummary>>("/traces?limit=100&failed=true")).items;
    assert.equal(failed.length, failures + triggers);

  } finally {
    await shop.dispose();
  }
});
