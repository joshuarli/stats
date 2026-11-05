import test from "node:test";
import assert from "node:assert/strict";
import { prepareTailItems, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { ALWAYS_KEPT_PER_BUCKET, AlwaysKeptCap } from "../../src/observe/core/always-kept-cap.ts";
import { POLICIES, type ServicePolicy } from "../../src/observe/cloudflare/policies.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";
import { OTHER_ROUTE, type CountDelta } from "../../src/observe/core/model.ts";
import { cleanup, health, ingest, nextCleanupAt, statsWindow } from "../../src/observe/core/store.ts";
import type { SqlStatements } from "../../src/core/sql.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { COUNT_BUCKET_MS, HEALTH_BUCKET_MS, MAX_OUTCOME_ROUTES_PER_CLASS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import { cleanupCounts, recordCounts } from "../../src/observe/core/counts.ts";
import { MILLION, sampled } from "../../src/observe/core/sampling.ts";
import { decodeExploration, decodeHealth, decodeObjectMethods, decodeStatsWindow, decodeTrace, decodeTraces } from "../../src/observe/client/decode.ts";
import { T0, VERSION, database, hex } from "./support.ts";

const SHOP = POLICIES["nanoshop-storied"];
const OBJECT = "71437be8483ec4c778560417396a6e8e81f1673f27ec5d341ec7a2645e467eb9";
const START = T0 - (T0 % COUNT_BUCKET_MS);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Expectation {
  readonly key: string;
  readonly cpu: number;
  readonly wall: number;
}

interface Generated {
  readonly items: TailItem[];
  readonly expected: Expectation[];
  readonly failures: number;
}

function operationMessage(traceId: string, spanId: string, operation: string) {
  return { channel: OBSERVE_CHANNEL, message: { kind: "operation", traceId, spanId, operation, synthetic: false, rows: null } };
}

function workerItem(n: number, atMs: number, path: string, method: string, status: number, operation: string | null, overrides: Partial<TailItem> = {}): TailItem {
  return {
    event: { request: { url: `https://shop.example${path}`, method }, response: { status } },
    eventTimestamp: atMs, exceptions: [],
    diagnosticsChannelEvents: operation === null ? [] : [operationMessage(hex(n + 1, 32), hex(2 * n + 1, 16), operation)],
    scriptVersion: { id: VERSION }, scriptName: "nanoshop-storied", executionModel: "stateless", outcome: "ok", cpuTime: 1, wallTime: 20, ...overrides
  };
}

function objectItem(n: number, atMs: number, rpcMethod: string, operation: string, overrides: Partial<TailItem> = {}): TailItem {
  return {
    ...workerItem(n, atMs, "/", "GET", 200, null),
    event: { rpcMethod }, executionModel: "durableObject", durableObjectId: OBJECT, entrypoint: "TenantStore",
    diagnosticsChannelEvents: [operationMessage(hex(n + 1, 32), hex(2 * n + 2, 16), operation)], ...overrides
  };
}

function generate(count: number, seed: number): Generated {
  const next = random(seed);
  const items: TailItem[] = [];
  const expected: Expectation[] = [];
  let failures = 0;
  const add = (item: TailItem, stage: string, outcome: string, route: string, operation: string) => {
    items.push(item);
    expected.push({ key: [stage, outcome, route, operation].join("|"), cpu: Math.round(item.cpuTime), wall: Math.round(item.wallTime) });
    if (outcome === "failed") failures++;
  };
  for (let n = 0; items.length < count; n++) {
    const at = START + Math.floor(n * 31 * COUNT_BUCKET_MS / 1000) % (5 * COUNT_BUCKET_MS);
    const roll = next();
    const cpuTime = 1 + Math.floor(next() * 4);
    const wallTime = 5 + Math.floor(next() * 60);
    if (roll < 0.5) add(workerItem(n, at, `/products/handle-${Math.floor(next() * 50)}`, "GET", 200, "request.product", { cpuTime, wallTime }), "worker", "ok", "GET /products/:handle", "request.product");
    else if (roll < 0.7) add(workerItem(n, at, "/search", "GET", 200, "request.search", { cpuTime, wallTime }), "worker", "ok", "GET /search", "request.search");
    else if (roll < 0.8) {
      add(workerItem(n, at, "/cart/items", "POST", 200, "request.cart-add", { cpuTime, wallTime }), "worker", "ok", "POST /cart/items", "request.cart-add");
      add(objectItem(n, at + 1, "addToCart", "store.rpc.addToCart", { cpuTime: 1, wallTime: 4 }), "object", "ok", "TenantStore.addToCart", "store.rpc.addToCart");
    } else if (roll < 0.85) add(workerItem(n, at, "/static/app.css", "GET", 200, null, { cpuTime, wallTime }), "worker", "excluded-route", OTHER_ROUTE, "");
    else if (roll < 0.9) add(workerItem(n, at, "/products/gone", "GET", 404, "request.product", { cpuTime, wallTime }), "worker", "excluded-status:404", "GET /products/:handle", "");
    else if (roll < 0.93) add(workerItem(n, at, "/cart", "GET", 500, "request.cart", { cpuTime, wallTime }), "worker", "failed", "GET /cart", "request.cart");
    else if (roll < 0.95) add(workerItem(n, at, "/", "GET", 200, "request.home", { exceptions: [{ name: "TypeError", message: "x" }], outcome: "exception", cpuTime, wallTime }), "worker", "failed", "GET /", "request.home");
    else if (roll < 0.97) add(workerItem(n, at, "/collections", "GET", 200, "request.collections", { cpuTime: 12, wallTime: 150 }), "worker", "ok", "GET /collections", "request.collections");
    else add(workerItem(n, at, "/products", "GET", 200, "request.products", { cpuTime, wallTime }), "worker", "ok", "GET /products", "request.products");
  }
  return { items, expected, failures };
}

function tally(db: SqlStatements) {
  const rows = db.rows<{ stage: string; outcome: string; route: string; operation: string; kept: number; sampled_out: number; cpu: number; wall: number }>(
    "SELECT stage, outcome, route, operation, SUM(kept) AS kept, SUM(sampled_out) AS sampled_out, SUM(cpu_ms_sum) AS cpu, SUM(wall_ms_sum) AS wall FROM observe_count_entries GROUP BY stage, outcome, route, operation"
  );
  return new Map(rows.map(row => [[row.stage, row.outcome, row.route, row.operation].join("|"), row]));
}

await test("counts over 10,000 seeded events equal the input exactly, and kept rows equal the kept count", async () => {
  const { items, expected, failures } = generate(10_000, 7);
  assert.ok(items.length >= 10_000);
  const db = database();
  const next = random(11);
  for (let at = 0; at < items.length;) {
    const size = 1 + Math.floor(next() * 40);
    const slice = items.slice(at, at + size);
    at += slice.length;
    const nowMs = Math.max(...slice.map(item => item.eventTimestamp ?? 0)) + 1_000;
    const batch = await prepareTailItems(slice, SHOP, nowMs, new AlwaysKeptCap());
    ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: SHOP.sampling, counts: batch.counts });
  }
  const want = new Map<string, { count: number; cpu: number; wall: number }>();
  for (const entry of expected) {
    const total = want.get(entry.key) ?? { count: 0, cpu: 0, wall: 0 };
    want.set(entry.key, { count: total.count + 1, cpu: total.cpu + entry.cpu, wall: total.wall + entry.wall });
  }
  const got = tally(db);
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort());
  for (const [key, total] of want) {
    const row = got.get(key)!;
    assert.deepEqual([row.kept + row.sampled_out, row.cpu, row.wall], [total.count, total.cpu, total.wall], key);
  }
  const keptRows = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n;
  const keptCount = [...got.values()].reduce((sum, row) => sum + row.kept, 0);
  assert.equal(keptRows, keptCount);
  assert.ok(keptRows >= failures, "every failure is kept");
  assert.ok(keptRows < items.length / 4, `${keptRows} of ${items.length} kept`);
  assert.equal(db.rows("SELECT 1 FROM observe_outcomes").length, 0, "no event of a sampled service is an outcome row");
  const failedRows = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations WHERE failed = 1")[0]!.n;
  assert.equal(failedRows, failures);
  const window = statsWindow(db, { fromMs: START, toMs: START + 5 * COUNT_BUCKET_MS }, SHOP.sampling);
  const observed = window.invocations.reduce((sum, row) => sum + row.count, 0) + window.outcomes.reduce((sum, row) => sum + row.count, 0);
  assert.equal(observed, items.length);
  const byRoute = new Map<string, { count: number; failed: number; cpuMsSum: number; wallMsSum: number }>();
  for (const entry of expected) {
    const [stage, outcome, route, operation] = entry.key.split("|");
    if (outcome !== "ok" && outcome !== "failed") continue;
    const key = [stage, route, operation].join("|");
    const total = byRoute.get(key) ?? { count: 0, failed: 0, cpuMsSum: 0, wallMsSum: 0 };
    byRoute.set(key, { count: total.count + 1, failed: total.failed + (outcome === "failed" ? 1 : 0), cpuMsSum: total.cpuMsSum + entry.cpu, wallMsSum: total.wallMsSum + entry.wall });
  }
  assert.deepEqual(new Map(window.counts?.map(row => [[row.stage, row.route, row.operation].join("|"), { count: row.count, failed: row.failed, cpuMsSum: row.cpuMsSum, wallMsSum: row.wallMsSum }])), byRoute);
  assert.deepEqual(new Set(window.counts?.map(row => row.version)), new Set([VERSION]));
});

await test("every always-keep case is stored with its count, and an untraced invocation is counted untraced", async () => {
  const quiet = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: quiet };
  const db = database();
  const nowMs = START + 10_000;
  const cases: TailItem[] = [
    workerItem(1, START + 1, "/cart", "GET", 200, "request.cart", { exceptions: [{ name: "TypeError", message: "x" }] }),
    workerItem(2, START + 2, "/cart", "GET", 500, "request.cart"),
    workerItem(3, START + 3, "/cart", "GET", 200, "request.cart", { outcome: "exceededCpu" }),
    workerItem(4, START + 4, "/cart", "GET", 200, "request.cart", { wallTime: 100 }),
    workerItem(5, START + 5, "/cart", "GET", 200, "request.cart", { cpuTime: 10 }),
    workerItem(6, START + 6, "/cart", "GET", 200, null),
    workerItem(7, START + 7, "/cart", "GET", 200, "request.cart", { diagnosticsChannelEvents: [operationMessage(hex(8, 32), hex(8, 16), "request.cart"), { channel: OBSERVE_CHANNEL, message: { kind: "error", operation: "request.cart", name: "Error", message: "", stack: null } }] })
  ];
  const batch = await prepareTailItems(cases, policy, nowMs, new AlwaysKeptCap());
  ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: quiet, counts: batch.counts });
  assert.equal(db.rows("SELECT 1 FROM observe_invocations").length, cases.length);
  assert.equal(batch.counts.length, 0);
  const row = db.rows<{ kept: number; sampled_out: number }>("SELECT SUM(kept) AS kept, SUM(sampled_out) AS sampled_out FROM observe_count_entries")[0]!;
  assert.deepEqual([row.kept, row.sampled_out], [cases.length, 0]);
  const untraced = db.rows<{ untraced: number }>("SELECT untraced FROM observe_counts");
  assert.deepEqual(untraced.map(entry => entry.untraced), [1]);
});

await test("an invalid event of a sampled service keeps today's rejection and is not counted", async () => {
  const quiet = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: quiet };
  const db = database();
  const nowMs = START + 10_000;
  const badVersion = workerItem(1, START + 1, "/cart", "GET", 200, "request.cart", { scriptVersion: { id: "bad version" } });
  const badStage = workerItem(2, START + 2, "/cart", "GET", 200, "request.cart", { executionModel: "dispatch" });
  const batch = await prepareTailItems([badVersion, badStage], policy, nowMs, new AlwaysKeptCap());
  ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: quiet, counts: batch.counts });
  assert.equal(db.rows("SELECT 1 FROM observe_counts").length, 0);
  assert.deepEqual(db.rows<{ outcome: string; count: number }>("SELECT outcome, SUM(count) AS count FROM observe_outcomes GROUP BY outcome").map(row => ({ ...row })), [{ outcome: "rejected-invalid", count: 2 }]);
});

await test("excluded events of a sampled service are counted by outcome, not stored as invocations or outcome rows", async () => {
  const db = database();
  const nowMs = START + 10_000;
  const items = [
    workerItem(1, START + 1, "/static/a.css", "GET", 200, null),
    workerItem(2, START + 2, "/static/b.css", "GET", 200, null),
    workerItem(3, START + 3, "/cart", "GET", 401, "request.cart"),
    workerItem(4, START + 4, "/nope", "GET", 404, null)
  ];
  const batch = await prepareTailItems(items, SHOP, nowMs, new AlwaysKeptCap());
  ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: SHOP.sampling, counts: batch.counts });
  assert.equal(db.rows("SELECT 1 FROM observe_invocations").length, 0);
  assert.equal(db.rows("SELECT 1 FROM observe_outcomes").length, 0);
  assert.deepEqual(db.rows<{ outcome: string; route: string; sampled_out: number }>("SELECT outcome, route, SUM(sampled_out) AS sampled_out FROM observe_count_entries GROUP BY outcome, route ORDER BY outcome, route").map(row => ({ ...row })), [
    { outcome: "excluded-route", route: OTHER_ROUTE, sampled_out: 2 },
    { outcome: "excluded-status:401", route: "GET /cart", sampled_out: 1 },
    { outcome: "excluded-status:404", route: OTHER_ROUTE, sampled_out: 1 }
  ]);
  const window = statsWindow(db, { fromMs: START, toMs: START + COUNT_BUCKET_MS }, SHOP.sampling);
  assert.deepEqual(window.outcomes.map(row => [row.outcome, row.count]), [["excluded-route", 2], ["excluded-status:401", 1], ["excluded-status:404", 1]]);
  assert.deepEqual(window.invocations, []);
});

await test("routes beyond the per-class cap fold into other, and malformed or expired counts are refused with a health reason", async () => {
  const db = database();
  const nowMs = START + 10_000;
  const base: CountDelta = { bucketAt: START, version: VERSION, stage: "worker", route: "GET /x", operation: "", outcome: "ok", kept: 0, sampledOut: 1, capped: 0, cpuMsSum: 1, wallMsSum: 1 };
  const counts = Array.from({ length: MAX_OUTCOME_ROUTES_PER_CLASS + 5 }, (_, n): CountDelta => ({ ...base, route: `GET /r${n}` }));
  ingest(db, [], nowMs, [], { sampling: SHOP.sampling, counts });
  const routes = db.rows<{ route: string; sampled_out: number }>("SELECT route, SUM(sampled_out) AS sampled_out FROM observe_count_entries GROUP BY route");
  assert.equal(routes.length, MAX_OUTCOME_ROUTES_PER_CLASS + 1);
  assert.equal(routes.find(row => row.route === OTHER_ROUTE)?.sampled_out, 5);
  const refused: CountDelta[] = [
    { ...base, bucketAt: START + 1 },
    { ...base, version: "bad version" },
    { ...base, operation: "Bad Op" },
    { ...base, sampledOut: -1 },
    { ...base, kept: 0, sampledOut: 0 },
    { ...base, bucketAt: nowMs - RETENTION_MS - 2 * COUNT_BUCKET_MS - ((nowMs - RETENTION_MS) % COUNT_BUCKET_MS) }
  ];
  ingest(db, [], nowMs, [], { sampling: SHOP.sampling, counts: refused });
  const reasons = health(db, nowMs, SHOP.sampling).reasons.map(reason => [reason.counter, reason.reason, reason.count]);
  assert.deepEqual(reasons, [["rejected", "invalid_count", 5], ["expired", "counts", 1]]);
  assert.equal(db.rows<{ n: number }>("SELECT SUM(sampled_out) AS n FROM observe_count_entries")[0]!.n, MAX_OUTCOME_ROUTES_PER_CLASS + 5);
});

await test("a count with a future bucket lands in the current bucket", () => {
  const db = database();
  const nowMs = START + 10_000;
  ingest(db, [], nowMs, [], { sampling: SHOP.sampling, counts: [{ bucketAt: START + 4 * COUNT_BUCKET_MS, version: VERSION, stage: "worker", route: "GET /x", operation: "", outcome: "ok", kept: 0, sampledOut: 1, capped: 0, cpuMsSum: 0, wallMsSum: 0 }] });
  assert.deepEqual(db.rows<{ bucket_at: number }>("SELECT bucket_at FROM observe_counts").map(row => ({ ...row })), [{ bucket_at: START }]);
});

await test("health reports kept, sampled out, excluded, untraced and flushed batches with the policy, and only for a sampled service", async () => {
  const quiet = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: quiet };
  const db = database();
  const nowMs = START + 10_000;
  const items = [
    workerItem(1, START + 1, "/search", "GET", 200, "request.search"),
    workerItem(2, START + 2, "/search", "GET", 200, "request.search"),
    workerItem(3, START + 3, "/search", "GET", 500, "request.search"),
    workerItem(4, START + 4, "/search", "GET", 200, null),
    workerItem(5, START + 5, "/static/x", "GET", 200, null)
  ];
  const batch = await prepareTailItems(items, policy, nowMs, new AlwaysKeptCap());
  ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: quiet, counts: batch.counts });
  const sampledHealth = health(db, nowMs, quiet).sampling;
  assert.deepEqual(sampledHealth, { policy: quiet, kept: 2, sampledOut: 2, excluded: 1, untraced: 1, flushes: 1, capped: 0 });
  assert.equal("sampling" in health(db, nowMs), false);
});

await test("a service that keeps everything writes nothing to the count tables, and a sampled one is cleaned up with them", async () => {
  const all = database();
  const nowMs = START + 10_000;
  const items = [workerItem(1, START + 1, "/search", "GET", 200, "request.search"), workerItem(2, START + 2, "/static/x", "GET", 200, null)];
  const batch = await prepareTailItems(items, POLICIES["usr-memories"], nowMs, new AlwaysKeptCap());
  assert.deepEqual(batch.counts, []);
  ingest(all, batch.preparations, nowMs, batch.outcomes, { sampling: POLICIES["usr-memories"].sampling, counts: batch.counts });
  assert.equal(all.rows("SELECT 1 FROM observe_counts").length, 0);

  const db = database();
  const shop = await prepareTailItems(items, SHOP, nowMs, new AlwaysKeptCap());
  ingest(db, shop.preparations, nowMs, shop.outcomes, { sampling: SHOP.sampling, counts: shop.counts });
  const later = nowMs + RETENTION_MS + 2 * HEALTH_BUCKET_MS;
  assert.ok(nextCleanupAt(db, nowMs, { deleted: 0, evicted: 0, more: false }) !== null);
  cleanup(db, later);
  assert.equal(db.rows("SELECT 1 FROM observe_counts").length, 0);
});

await test("the service answers a sampled window, explore, and traces with the policy's sampling summary and exact route counts", async () => {
  const quiet = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: quiet };
  const db = database();
  const nowMs = START + 10_000;
  const items = [
    ...Array.from({ length: 7 }, (_, n) => workerItem(n, START + n, "/search", "GET", 200, "request.search")),
    workerItem(10, START + 10, "/search", "GET", 500, "request.search")
  ];
  const batch = await prepareTailItems(items, policy, nowMs, new AlwaysKeptCap());
  ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: quiet, counts: batch.counts });
  const service = createObserveService(db, { now: () => nowMs, databaseBytes: () => 0 }, () => quiet);
  const summary = { keepPerMillion: 0, kept: 1, observed: 8 };
  const explored = await service.explore({ fromMs: START, toMs: START + COUNT_BUCKET_MS });
  assert.deepEqual(explored.sampling, summary);
  assert.deepEqual(explored.routes.map(route => [route.label, route.requests, route.observed]), [["GET /search", 1, 8]]);
  assert.deepEqual((await service.traces({ fromMs: START, toMs: START + COUNT_BUCKET_MS })).sampling, summary);
  assert.deepEqual((await service.window({ fromMs: START, toMs: START + COUNT_BUCKET_MS })).sampling, summary);
  assert.deepEqual((await service.objects({ fromMs: START, toMs: START + COUNT_BUCKET_MS })).sampling, { keepPerMillion: 0, kept: 0, observed: 0 });
  const trace = await service.trace(hex(11, 32));
  assert.deepEqual(trace?.sampling, summary);
  assert.deepEqual((await service.health()).sampling?.kept, 1);
  const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
  assert.deepEqual(decodeExploration(wire(explored)), explored);
  assert.deepEqual(decodeTraces(wire(await service.traces({ fromMs: START, toMs: START + COUNT_BUCKET_MS }))).sampling, summary);
  assert.deepEqual(decodeObjectMethods(wire(await service.objects({ fromMs: START, toMs: START + COUNT_BUCKET_MS }))).sampling, { keepPerMillion: 0, kept: 0, observed: 0 });
  const window = await service.window({ fromMs: START, toMs: START + COUNT_BUCKET_MS });
  assert.deepEqual(decodeStatsWindow(wire(window)).sampling, summary);
  assert.deepEqual(decodeStatsWindow(wire(window)).counts, [{ version: VERSION, stage: "worker", route: "GET /search", operation: "request.search", count: 8, failed: 1, cpuMsSum: 8, wallMsSum: 160 }]);
  assert.deepEqual(decodeTrace(wire(trace), hex(11, 32)).sampling, summary);
  assert.deepEqual(decodeHealth(wire(await service.health())).sampling, (await service.health()).sampling);
  assert.throws(() => decodeExploration(wire({ ...explored, sampling: { keepPerMillion: 2_000_000, kept: 0, observed: 0 } })));
});

function flushOf(random: () => number, bucketAt: number, keys: number, events: number): CountDelta[] {
  const deltas: CountDelta[] = [];
  for (let n = 0; n < events; n++) {
    const key = Math.floor(random() * keys);
    const failed = random() < 0.1;
    deltas.push({
      bucketAt, version: VERSION, stage: key % 2 === 0 ? "worker" : "object", route: `GET /r${key}`, operation: `request.r${key}`, outcome: failed ? "failed" : "ok",
      kept: random() < 0.2 ? 1 : 0, sampledOut: 1, capped: 0, cpuMsSum: 1 + Math.floor(random() * 5), wallMsSum: 5 + Math.floor(random() * 60)
    });
  }
  return deltas;
}

function totals(deltas: readonly CountDelta[]): Map<string, number[]> {
  const sums = new Map<string, number[]>();
  for (const delta of deltas) {
    const key = [delta.bucketAt, delta.stage, delta.outcome, delta.route, delta.operation].join("|");
    const sum = sums.get(key) ?? [0, 0, 0, 0];
    sums.set(key, [sum[0]! + delta.kept, sum[1]! + delta.sampledOut, sum[2]! + delta.cpuMsSum, sum[3]! + delta.wallMsSum]);
  }
  return sums;
}

await test("many flushes from several isolates merge into one row per bucket and sum exactly", () => {
  const db = database();
  const next = random(31);
  const nowMs = START + 3 * COUNT_BUCKET_MS + 10_000;
  const sent: CountDelta[] = [];
  let flushes = 0;
  for (let round = 0; round < 40; round++) {
    for (let isolate = 0; isolate < 3; isolate++) {
      const buckets = [START + Math.floor(next() * 4) * COUNT_BUCKET_MS];
      if (next() < 0.3) buckets.push(START + Math.floor(next() * 4) * COUNT_BUCKET_MS);
      const flush = buckets.flatMap(bucketAt => flushOf(next, bucketAt, 14, 1 + Math.floor(next() * 200)));
      const before = db.rowsWritten();
      recordCounts(db, nowMs, flush, { untraced: 0, flush: 1 });
      assert.equal(db.rowsWritten() - before, new Set(flush.map(delta => delta.bucketAt)).size, "a flush writes one row per bucket it touches, however many keys it carries");
      sent.push(...flush);
      flushes++;
    }
  }
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_counts")[0]!.n, 4);
  assert.equal(db.rows<{ n: number }>("SELECT SUM(flushes) AS n FROM observe_counts")[0]!.n, flushes);
  const stored = new Map(db.rows<{ bucket_at: number; stage: string; outcome: string; route: string; operation: string; kept: number; sampled_out: number; cpu_ms_sum: number; wall_ms_sum: number }>(
    "SELECT bucket_at, stage, outcome, route, operation, kept, sampled_out, cpu_ms_sum, wall_ms_sum FROM observe_count_entries"
  ).map(row => [[row.bucket_at, row.stage, row.outcome, row.route, row.operation].join("|"), [row.kept, row.sampled_out, row.cpu_ms_sum, row.wall_ms_sum]]));
  assert.deepEqual(stored, totals(sent));
  assert.equal(sent.reduce((sum, delta) => sum + delta.kept + delta.sampledOut, 0), db.rows<{ n: number }>("SELECT SUM(kept + sampled_out) AS n FROM observe_count_entries")[0]!.n);
});

await test("the route cap holds across flushes because the stored bucket remembers its routes", () => {
  const db = database();
  const nowMs = START + 10_000;
  const base: CountDelta = { bucketAt: START, version: VERSION, stage: "worker", route: "GET /x", operation: "", outcome: "ok", kept: 0, sampledOut: 1, capped: 0, cpuMsSum: 0, wallMsSum: 0 };
  for (let n = 0; n < MAX_OUTCOME_ROUTES_PER_CLASS + 5; n++) recordCounts(db, nowMs, [{ ...base, route: `GET /r${n}` }], { untraced: 0, flush: 1 });
  recordCounts(db, nowMs, [{ ...base, route: "GET /r0" }], { untraced: 0, flush: 1 });
  const rows = db.rows<{ route: string; sampled_out: number }>("SELECT route, sampled_out FROM observe_count_entries");
  assert.equal(rows.length, MAX_OUTCOME_ROUTES_PER_CLASS + 1);
  assert.equal(rows.find(row => row.route === OTHER_ROUTE)?.sampled_out, 5);
  assert.equal(rows.find(row => row.route === "GET /r0")?.sampled_out, 2);
});

await test("retention deletes one row per expired bucket whatever its key count, and leaves newer totals alone", () => {
  const db = database();
  const next = random(5);
  const old = START - 2 * COUNT_BUCKET_MS;
  const fresh = START + RETENTION_MS;
  const nowMs = fresh + 10_000;
  recordCounts(db, old + RETENTION_MS - 60_000, [...flushOf(next, old, 14, 300), ...flushOf(next, old + COUNT_BUCKET_MS, 14, 300)], { untraced: 0, flush: 1 });
  const kept = flushOf(next, fresh - (fresh % COUNT_BUCKET_MS), 14, 300);
  recordCounts(db, nowMs, kept, { untraced: 0, flush: 1 });
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_counts")[0]!.n, 3);
  const before = db.rowsWritten();
  cleanupCounts(db, nowMs - RETENTION_MS);
  assert.equal(db.rowsWritten() - before, 2);
  assert.deepEqual(db.rows<{ bucket_at: number }>("SELECT bucket_at FROM observe_counts").map(row => row.bucket_at), [fresh - (fresh % COUNT_BUCKET_MS)]);
  assert.equal(db.rows<{ n: number }>("SELECT SUM(kept + sampled_out) AS n FROM observe_count_entries")[0]!.n, kept.reduce((sum, delta) => sum + delta.kept + delta.sampledOut, 0));
});

function failures(from: number, count: number, atMs: number): TailItem[] {
  return Array.from({ length: count }, (_, n) => workerItem(from + n, atMs + n, "/cart", "GET", 500, "request.cart"));
}

async function deliverInBatches(db: SqlStatements, policy: ServicePolicy, cap: AlwaysKeptCap, items: readonly TailItem[], nowMs: number): Promise<void> {
  for (let at = 0; at < items.length; at += 7) {
    const batch = await prepareTailItems(items.slice(at, at + 7), policy, nowMs, cap);
    ingest(db, batch.preparations, nowMs, batch.outcomes, { sampling: policy.sampling, counts: batch.counts });
  }
}

await test("failures past the per-bucket cap are counted as failed and sampled out, so failure totals stay exact and health reports the cap", async () => {
  const quiet = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: quiet };
  const db = database();
  const nowMs = START + 10_000;
  const total = ALWAYS_KEPT_PER_BUCKET + 15;
  await deliverInBatches(db, policy, new AlwaysKeptCap(), failures(1, total, START + 1), nowMs);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n, ALWAYS_KEPT_PER_BUCKET);
  const counted = db.rows<{ outcome: string; kept: number; sampled_out: number }>("SELECT outcome, SUM(kept) AS kept, SUM(sampled_out) AS sampled_out FROM observe_count_entries GROUP BY outcome").map(row => ({ ...row }));
  assert.deepEqual(counted, [{ outcome: "failed", kept: ALWAYS_KEPT_PER_BUCKET, sampled_out: total - ALWAYS_KEPT_PER_BUCKET }]);
  assert.deepEqual(health(db, nowMs, quiet).sampling, { policy: quiet, kept: ALWAYS_KEPT_PER_BUCKET, sampledOut: total - ALWAYS_KEPT_PER_BUCKET, excluded: 0, untraced: 0, flushes: 3, capped: total - ALWAYS_KEPT_PER_BUCKET });
  const window = statsWindow(db, { fromMs: START, toMs: START + COUNT_BUCKET_MS }, quiet);
  assert.equal(window.invocations.reduce((sum, row) => sum + row.count, 0), total);
  assert.equal(versionFailures(db), total);
});

function versionFailures(db: SqlStatements): number {
  return db.rows<{ n: number }>("SELECT SUM(kept + sampled_out) AS n FROM observe_count_entries WHERE outcome = 'failed'")[0]!.n;
}

await test("the cap starts over in the next bucket, and each isolate's cap is its own", async () => {
  const quiet = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: quiet };
  const db = database();
  const cap = new AlwaysKeptCap();
  const nowMs = START + COUNT_BUCKET_MS + 10_000;
  await deliverInBatches(db, policy, cap, [...failures(1, 12, START + 1), ...failures(100, 12, START + COUNT_BUCKET_MS + 1)], nowMs);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n, 2 * ALWAYS_KEPT_PER_BUCKET);
  await deliverInBatches(db, policy, new AlwaysKeptCap(), failures(200, 3, START + COUNT_BUCKET_MS + 50), nowMs);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n, 2 * ALWAYS_KEPT_PER_BUCKET + 3);
  assert.equal(versionFailures(db), 27);
});

await test("trace-hash keeps are not capped", async () => {
  const everything = sampled({ keepPerMillion: MILLION, slowWallMs: 100, slowCpuMs: 10 });
  const policy = { ...SHOP, sampling: everything };
  const db = database();
  const items = Array.from({ length: 3 * ALWAYS_KEPT_PER_BUCKET }, (_, n) => workerItem(n + 1, START + 1 + n, "/search", "GET", 200, "request.search"));
  await deliverInBatches(db, policy, new AlwaysKeptCap(), items, START + 10_000);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n, items.length);
  assert.equal(health(db, START + 10_000, everything).sampling?.capped, 0);
});

await test("a service that keeps everything stores every failure and counts nothing", async () => {
  const policy = POLICIES["usr-memories"];
  const db = database();
  const nowMs = START + 10_000;
  await deliverInBatches(db, policy, new AlwaysKeptCap(), Array.from({ length: 100 }, (_, n) => workerItem(n + 1, START + 1 + n, "/", "GET", 500, "request.route")), nowMs);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n, 100);
  assert.equal(db.rows("SELECT 1 FROM observe_counts").length, 0);
});
