import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { collectorModules, until, type Page, type TraceSummary } from "./harness.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";
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

interface Shop {
  readonly mf: Miniflare;
  send(path: string, method?: string): Promise<void>;
  observe<T>(path: string): Promise<T>;
  dispose(): Promise<void>;
}

async function startShop(): Promise<Shop> {
  const persist = mkdtempSync(join(tmpdir(), "sampling-e2e-"));
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [
      { name: SERVICE, modules: true, script: PRODUCER, ...COMPAT, tails: ["stats-observe"], durableObjects: { STORE: { className: "TenantStore", useSQLite: true } } },
      {
        name: "stats-observe",
        modules: collectorModules(SERVICE),
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
    const health = await until(() => shop.observe<Health>("/health"), value => value.sampling !== undefined && value.sampling.kept + value.sampling.sampledOut + value.sampling.excluded >= events, "every tail event");
    const sampling = health.sampling!;
    assert.deepEqual([sampling.kept + sampling.sampledOut, sampling.excluded, sampling.untraced], [events - assets, assets, 0]);
    assert.equal(health.liveInvocations, sampling.kept);
    assert.ok(sampling.kept < (events - assets) / 10, `${sampling.kept} kept`);
    assert.deepEqual([sampling.policy.keepPerMillion, health.rejected], [10_000, 0]);

    const bucket = Math.floor(Date.now() / COUNT_BUCKET_MS) * COUNT_BUCKET_MS;
    const window = await shop.observe<StatsWindow>(`/window?from=${bucket - COUNT_BUCKET_MS}&to=${bucket + 2 * COUNT_BUCKET_MS}`);
    assert.equal(window.invocations.reduce((sum, row) => sum + row.count, 0), events - assets);
    assert.equal(window.outcomes.filter(row => row.outcome === "excluded-route").reduce((sum, row) => sum + row.count, 0), assets);
    assert.deepEqual(window.sampling, { keepPerMillion: 10_000, kept: sampling.kept, observed: events - assets });

    const range = `from=${bucket - COUNT_BUCKET_MS}&to=${bucket + 2 * COUNT_BUCKET_MS}`;
    const explored = await shop.observe<Exploration>(`/explore?${range}`);
    const workerEvents = carts + searches + failures;
    assert.equal(explored.sampling?.observed, workerEvents);
    assert.equal(explored.routes.reduce((sum, route) => sum + route.requests, 0), explored.sampling?.kept);
    assert.deepEqual(Object.fromEntries(explored.routes.map(route => [route.label, route.observed])), { "GET /cart": failures, "GET /search": searches, "POST /cart/items": carts });
    const traces = await shop.observe<Page<TraceSummary> & { sampling?: { observed: number; kept: number } }>("/traces?limit=100");
    assert.deepEqual([traces.sampling?.observed, traces.sampling?.kept], [workerEvents, explored.sampling?.kept]);
    const objects = await shop.observe<ObjectMethods>(`/objects?${range}`);
    const keptCarts = explored.routes.find(route => route.label === "POST /cart/items");
    assert.ok(keptCarts !== undefined && keptCarts.requests > 0, "some cart requests are kept");
    assert.equal(objects.sampling?.observed, carts);
    assert.equal(objects.methods.find(method => method.label === "TenantStore.addToCart")?.requests, keptCarts.requests, "a kept cart request keeps its Durable Object invocation, and no other does");
    const failed = (await shop.observe<Page<TraceSummary>>("/traces?limit=100&failed=true")).items;
    assert.equal(failed.length, failures);

  } finally {
    await shop.dispose();
  }
});
