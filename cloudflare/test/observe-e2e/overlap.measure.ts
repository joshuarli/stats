import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { collectorModules } from "./harness.ts";
import { random } from "../observe/workload.ts";

const COMPAT = { compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat"] };
const SERVICE = "nanoshop-storied";

const SHOP = `
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
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cart (id INTEGER PRIMARY KEY AUTOINCREMENT, variant INTEGER NOT NULL)");
  }
  addToCart(variant) {
    mark("store.rpc.addToCart");
    this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec("INSERT INTO cart (variant) VALUES (?)", variant));
    return { ok: true };
  }
}
export default {
  async fetch(request, env) {
    mark("request.cart-add");
    await env.STORE.getByName("shop").addToCart(1);
    return new Response(null, { status: 303 });
  }
};`;

const CAPTURE = `
const histogram = {};
export default {
  tail(events) {
    for (const event of events) {
      if (event.executionModel !== "durableObject") continue;
      const messages = event.diagnosticsChannelEvents.filter(entry => entry.channel === "stats.observe").length;
      histogram[messages] = (histogram[messages] ?? 0) + 1;
    }
  },
  fetch() { return Response.json(histogram); }
};`;

interface Health { readonly sampling?: { readonly untraced: number; readonly kept: number; readonly sampledOut: number }; readonly rejected: number }

async function level(ratePerSecond: number, requests: number, seed: number): Promise<void> {
  const persist = mkdtempSync(join(tmpdir(), "overlap-"));
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [
      { name: SERVICE, modules: true, script: SHOP, ...COMPAT, tails: ["capture", "stats-observe"], durableObjects: { STORE: { className: "TenantStore", useSQLite: true } } },
      { name: "capture", modules: true, script: CAPTURE, ...COMPAT },
      { name: "stats-observe", modules: collectorModules(SERVICE), ...COMPAT, durableObjects: { STORE: { className: "ObservationStore", useSQLite: true } } }
    ] }),
    resourcePersistencePath: persist
  });
  try {
    const shop = await mf.getWorker(SERVICE);
    const collector = await mf.getWorker("stats-observe");
    const capture = await mf.getWorker("capture");
    for (let warm = 0; warm < 5; warm++) await (await shop.fetch("https://shop.example/cart/items", { method: "POST" })).arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 500));
    const baseline = await (await capture.fetch("https://capture/")).json() as Record<string, number>;
    const baseHealth = await (await collector.fetch(`https://observe/${SERVICE}/health`)).json() as Health;
    const rng = random(seed);
    const inflight: Promise<void>[] = [];
    let latest = 0;
    const started = Date.now();
    for (let n = 0; n < requests; n++) {
      latest += -Math.log(1 - rng()) / ratePerSecond * 1000;
      const wait = started + latest - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      inflight.push(shop.fetch("https://shop.example/cart/items", { method: "POST" }).then(response => response.arrayBuffer()).then(() => undefined));
    }
    await Promise.all(inflight);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const histogram = await (await capture.fetch("https://capture/")).json() as Record<string, number>;
    const health = await (await collector.fetch(`https://observe/${SERVICE}/health`)).json() as Health;
    const events = Object.keys(histogram).reduce((sum, key) => sum + (histogram[key] ?? 0) - (baseline[key] ?? 0), 0);
    const by = (count: number) => (histogram[count] ?? 0) - (baseline[count] ?? 0);
    const untraced = (health.sampling?.untraced ?? 0) - (baseHealth.sampling?.untraced ?? 0);
    const rejected = health.rejected - baseHealth.rejected;
    console.log(JSON.stringify({
      ratePerSecond, requests, objectEvents: events, zeroMessages: by(0), oneMessage: by(1), twoOrMore: events - by(0) - by(1),
      untracedShare: untraced / events, rejectedShare: rejected / events, collectorUntraced: untraced, collectorRejected: rejected,
      elapsedMs: Date.now() - started
    }));
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
}

const plan: readonly (readonly [number, number])[] = [[1, 60], [5, 200], [20, 500], [100, 1000], [500, 2000], [5000, 2000]];
for (const [rate, requests] of plan) await level(rate, requests, 17);
