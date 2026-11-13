import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { collectorModules, until, type Page, type TraceSummary } from "./harness.ts";
import { COUNT_FLUSH_INTERVAL_MS } from "../../src/observe/core/count-buffer.ts";
import { ALWAYS_KEPT_PER_BUCKET } from "../../src/observe/core/always-kept-cap.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";
import { NANOSHOP_SAMPLING } from "../../src/observe/core/nanoshop-policy.ts";
import { fnv1a32, MILLION } from "../../src/observe/core/sampling.ts";
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
function traced(response) {
  const span = tracing.getActiveSpan();
  if (span !== undefined) response.headers.set("x-trace-id", span.spanContext().traceId);
  return response;
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/cart/items") { mark("request.cart-add"); await objectNotSharedWithConcurrentRequests(env).addToCart(); return traced(Response.json({ ok: true })); }
    if (path === "/search") { mark("request.search"); return traced(Response.json({ ok: true })); }
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
  send(path: string, method?: string): Promise<string | null>;
  observe<T>(path: string): Promise<T>;
  collectorClockForward(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

async function startShop(): Promise<Shop> {
  const persist = mkdtempSync(join(tmpdir(), "sampling-e2e-"));
  const modules = collectorModules(SERVICE);
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [
      { name: SERVICE, modules: true, script: PRODUCER, ...COMPAT, tails: ["stats-observe"], durableObjects: { STORE: { className: "TenantStore", useSQLite: true } } },
      {
        name: "stats-observe",
        modules: [{ ...modules[0]!, contents: SKEWED_COLLECTOR }, modules[1]!],
        modulesRoot: dirname(modules[0]!.path),
        ...COMPAT, durableObjects: { STORE: { className: "ObservationStore", useSQLite: true } }
      }
    ] }),
    resourcePersistencePath: persist
  });
  const dispose = async (): Promise<void> => { await mf.dispose(); rmSync(persist, { recursive: true, force: true }); };
  try {
    const shop = await mf.getWorker(SERVICE);
    const collector = await mf.getWorker("stats-observe");
    return {
      mf,
      send: async (path, method = "GET") => {
        const response = await shop.fetch(`https://shop.example${path}`, { method });
        await response.arrayBuffer();
        return response.headers.get("x-trace-id");
      },
      observe: async <T>(path: string) => await (await collector.fetch(`https://observe/${SERVICE}${path}`)).json() as T,
      collectorClockForward: async ms => { await (await collector.fetch(`https://observe/clock-forward?ms=${ms}`)).arrayBuffer(); },
        dispose
    };
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "sampling startup and cleanup failed"); }
    throw error;
  }
}

async function sendAll(shop: Shop, requests: readonly (readonly [string, string])[]): Promise<(string | null)[]> {
  const traceIds: (string | null)[] = [];
  for (let at = 0; at < requests.length; at += 50) traceIds.push(...await Promise.all(requests.slice(at, at + 50).map(([path, method]) => shop.send(path, method))));
  return traceIds;
}

function keptByTraceHash(traceId: string | null): boolean {
  return traceId !== null && fnv1a32(traceId) % MILLION < NANOSHOP_SAMPLING.keepPerMillion;
}

async function startClearOfBucketEnd(): Promise<void> {
  const intoBucket = Date.now() % COUNT_BUCKET_MS;
  if (intoBucket > COUNT_BUCKET_MS - 8_000) await new Promise(resolve => setTimeout(resolve, COUNT_BUCKET_MS - intoBucket + 1_000));
}

await test("a sampled service is counted exactly, keeps a trace's Worker and Durable Object invocations together, and keeps every failure", async () => {
  const shop = await startShop();
  try {
    const round = 1_000, failures = 4, assets = 20;
    let carts = 0, searches = 0, cartKept = false, searchKept = false;
    await startClearOfBucketEnd();
    while (!cartKept || !searchKept) {
      assert.ok(carts < 10 * round, `the trace hash kept no cart or no search request in ${carts} of each`);
      cartKept = (await sendAll(shop, Array.from({ length: round }, () => ["/cart/items", "POST"] as const))).some(keptByTraceHash) || cartKept;
      searchKept = (await sendAll(shop, Array.from({ length: round }, () => ["/search", "GET"] as const))).some(keptByTraceHash) || searchKept;
      carts += round;
      searches += round;
    }
    await sendAll(shop, [
      ...Array.from({ length: failures }, () => ["/cart", "GET"] as const),
      ...Array.from({ length: assets }, () => ["/static/app.css", "GET"] as const)
    ]);
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

await test("failures past the per-bucket cap are counted as failed but not stored", async () => {
  const shop = await startShop();
  try {
    const failures = 30;
    await startClearOfBucketEnd();
    await sendAll(shop, Array.from({ length: failures }, () => ["/cart", "GET"] as const));
    await until(() => shop.observe<Health>("/health"), value => value.liveInvocations >= ALWAYS_KEPT_PER_BUCKET, "the stored failures");
    let triggers = 0;
    let health = await shop.observe<Health>("/health");
    while ((health.sampling?.capped ?? 0) < failures - ALWAYS_KEPT_PER_BUCKET) {
      assert.ok(triggers < 5, `capped ${health.sampling?.capped}`);
      await shop.collectorClockForward(COUNT_FLUSH_INTERVAL_MS + 1_000);
      await shop.send("/search");
      triggers++;
      health = await until(() => shop.observe<Health>("/health"), value => (value.sampling?.capped ?? 0) >= failures - ALWAYS_KEPT_PER_BUCKET, "the flush").catch(() => shop.observe<Health>("/health"));
    }
    assert.equal(health.liveInvocations, health.sampling?.kept);
    assert.equal(health.sampling?.capped, failures - ALWAYS_KEPT_PER_BUCKET);
    const bucket = Math.floor(Date.now() / COUNT_BUCKET_MS) * COUNT_BUCKET_MS;
    const explored = await shop.observe<Exploration>(`/explore?from=${bucket - COUNT_BUCKET_MS}&to=${bucket + 2 * COUNT_BUCKET_MS}`);
    assert.equal(explored.routes.find(route => route.label === "GET /cart")?.observed, failures);
    assert.equal((await shop.observe<Page<TraceSummary>>("/traces?limit=100&failed=true")).items.length, ALWAYS_KEPT_PER_BUCKET);
  } finally {
    await shop.dispose();
  }
});
