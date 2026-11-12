import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { TailItem } from "../../src/observe/cloudflare/tail.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";
import { NANOSHOP_ROUTES } from "../../src/observe/core/nanoshop-policy.ts";
import { fnv1a32, MILLION } from "../../src/observe/core/sampling.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";
import { OBSERVE_OUTPUT } from "../../local/topology.ts";
import { ensureBuild } from "../../scripts/ensure-build.ts";
import type { Health } from "../../src/observe/core/store.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SERVICE = "nanoshop-storied";
const VERSION = "3172128e-5c58-48a4-8c16-7767d5521979";
const OBJECT_ID = "71437be8483ec4c778560417396a6e8e81f1673f27ec5d341ec7a2645e467eb9";

const MEASURED_COLLECTOR = `
import collector, { ObservationStore as Store } from "./index.js";
let nowMs = Date.now();
Date.now = () => nowMs;
const meter = { rowsWritten: 0, setAlarms: 0, byTable: {} };
const requests = {};
const timers = [];
const waiting = [];
const TABLE = /^\\s*(?:INSERT(?: OR \\w+)? INTO|DELETE FROM|UPDATE)\\s+(\\w+)/iu;

function bound(target, key) {
  const value = target[key];
  return typeof value === "function" ? value.bind(target) : value;
}

let patched = false;

function measure(ctx) {
  if (patched) return;
  patched = true;
  const sqlPrototype = Object.getPrototypeOf(ctx.storage.sql);
  const exec = sqlPrototype.exec;
  sqlPrototype.exec = function (query, ...params) {
    const cursor = exec.call(this, query, ...params);
    return new Proxy(cursor, {
      get(inner, member) {
        if (member !== "toArray") return bound(inner, member);
        return () => {
          const rows = inner.toArray();
          meter.rowsWritten += inner.rowsWritten;
          const table = TABLE.exec(query)?.[1];
          if (table !== undefined && inner.rowsWritten > 0) meter.byTable[table] = (meter.byTable[table] ?? 0) + inner.rowsWritten;
          return rows;
        };
      }
    });
  };
  const storagePrototype = Object.getPrototypeOf(ctx.storage);
  const setAlarm = storagePrototype.setAlarm;
  storagePrototype.setAlarm = function (...args) { meter.setAlarms++; return setAlarm.apply(this, args); };
}

export class ObservationStore extends Store {
  constructor(ctx, env) { measure(ctx); super(ctx, env); }
  async meter() { return structuredClone(meter); }
  async runAlarm() { await this.alarm(); }
  async evict() { this.ctx.abort(); }
  async query(statement) { return this.ctx.storage.sql.exec(statement).toArray(); }
}

function counted(env) {
  return { STORE: { getByName(name) {
    const stub = env.STORE.getByName(name);
    return new Proxy(stub, { get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      return (...args) => { requests[key] = (requests[key] ?? 0) + 1; return Reflect.apply(value, target, args); };
    } });
  } } };
}

async function advance(to) {
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const due = timers[0];
    if (due === undefined || due.at > to) break;
    timers.shift();
    nowMs = Math.max(nowMs, due.at);
    due.fn();
    await waiting.shift();
  }
  nowMs = Math.max(nowMs, to);
}

async function tailOne(item, env) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ at: nowMs + ms, fn }); return timers.length; };
  try {
    await collector.tail([item], counted(env), { waitUntil: work => { waiting.push(work); }, passThroughOnException() {} });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

export default {
  ...collector,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/${SERVICE}/")) return collector.fetch(request, env, ctx);
    const body = await request.json();
    const store = env.STORE.getByName("${SERVICE}");
    switch (url.pathname) {
      case "/tail":
        for (const entry of body.entries) { await advance(entry.nowMs); nowMs = entry.nowMs; await tailOne(entry.item, env); }
        await advance(nowMs + body.settleMs);
        return Response.json({});
      case "/advance":
        await advance(body.to);
        return Response.json({});
      case "/meter":
        return Response.json({ ...(await store.meter()), requests: structuredClone(requests), nowMs, pendingTimers: timers.length });
      case "/alarm":
        await advance(body.at);
        await store.runAlarm();
        return Response.json({});
      case "/evict":
        try { await store.evict(); } catch (error) { return Response.json({ aborted: String(error) }); }
        return Response.json({ aborted: null });
      case "/query":
        return Response.json(await store.query(body.statement));
      default:
        return new Response("not found", { status: 404 });
    }
  }
};`;

export interface Meter {
  readonly rowsWritten: number;
  readonly setAlarms: number;
  readonly byTable: Readonly<Record<string, number>>;
  readonly requests: Readonly<Record<string, number>>;
  readonly nowMs: number;
  readonly pendingTimers: number;
}

export interface SimEntry {
  readonly nowMs: number;
  readonly item: TailItem;
}

export interface Rig {
  tail(entries: readonly SimEntry[], settleMs?: number): Promise<void>;
  advance(to: number): Promise<void>;
  meter(): Promise<Meter>;
  alarm(at: number): Promise<void>;
  evict(): Promise<void>;
  query<T>(statement: string): Promise<T[]>;
  health(): Promise<Health>;
  dispose(): Promise<void>;
}

export async function startRig(): Promise<Rig> {
  const artifact = process.env["STATS_OBSERVE_OUTPUT"] === undefined ? await ensureBuild("observe") : null;
  const observeBundle = join(artifact === null ? OBSERVE_OUTPUT : join(artifact.output, "v0/workers/default"), "bundle/index.js");
  const persist = mkdtempSync(join(tmpdir(), "budget-"));
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [{
      name: "stats-observe",
      modules: [
        { type: "ESModule" as const, path: join(ROOT, "observe-worker/collector-entry.js"), contents: MEASURED_COLLECTOR },
        { type: "ESModule" as const, path: join(ROOT, "observe-worker/index.js"), contents: readFileSync(observeBundle, "utf8") }
      ],
      compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { STORE: { className: "ObservationStore", useSQLite: true } }
    }] }),
    resourcePersistencePath: persist
  });
  const worker = await mf.getWorker("stats-observe");
  const startedAt = Math.ceil(Date.now() / COUNT_BUCKET_MS) * COUNT_BUCKET_MS + COUNT_BUCKET_MS;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await worker.fetch(`https://rig${path}`, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return await response.json() as T;
  };
  await post("/advance", { to: startedAt });
  return {
    tail: async (entries, settleMs = 0) => { await post("/tail", { entries, settleMs }); },
    advance: async to => { await post("/advance", { to }); },
    meter: () => post<Meter>("/meter", {}),
    alarm: async at => { await post("/alarm", { at }); },
    evict: async () => { await post("/evict", {}); },
    query: <T>(statement: string) => post<T[]>("/query", { statement }),
    health: async () => await (await worker.fetch(`https://rig/${SERVICE}/health`)).json() as Health,
    dispose: async () => { await mf.dispose(); rmSync(persist, { recursive: true, force: true }); }
  };
}

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Fate = "kept" | "dropped" | "natural";

export interface Generator {
  readonly keepPerMillion: number;
  next(): number;
}

function hex(rng: () => number, width: number): string {
  let text = "";
  while (text.length < width) text += Math.floor(rng() * 0x100000000).toString(16).padStart(8, "0");
  return text.slice(0, width);
}

export function traceFor(rng: () => number, keepPerMillion: number, fate: Fate): string {
  for (;;) {
    const traceId = hex(rng, 32);
    if (fate === "natural") return traceId;
    if ((fnv1a32(traceId) % MILLION < keepPerMillion) === (fate === "kept")) return traceId;
  }
}

export interface Shape {
  readonly route: typeof NANOSHOP_ROUTES[number]["name"];
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly status: number;
  readonly rpc: string | null;
}

const PAGE_ROUTES: readonly (readonly [number, Shape])[] = [
  [0.10, { route: "home", path: "/", method: "GET", status: 200, rpc: null }],
  [0.10, { route: "products", path: "/products", method: "GET", status: 200, rpc: null }],
  [0.05, { route: "collections", path: "/collections", method: "GET", status: 200, rpc: null }],
  [0.25, { route: "collection", path: "/collections/summer-sale", method: "GET", status: 200, rpc: null }],
  [0.50, { route: "product", path: "/products/linen-shirt", method: "GET", status: 200, rpc: null }]
];
const SEARCH: Shape = { route: "search", path: "/search?q=linen", method: "GET", status: 200, rpc: null };
const CART_ROUTES: readonly (readonly [number, Shape])[] = [
  [0.3, { route: "cart", path: "/cart", method: "GET", status: 200, rpc: "readCart" }],
  [0.4, { route: "cart-add", path: "/cart/items", method: "POST", status: 303, rpc: "addToCart" }],
  [0.2, { route: "cart-set", path: "/cart/items/42", method: "POST", status: 303, rpc: "setCartQuantity" }],
  [0.1, { route: "cart-remove", path: "/cart/items/42/remove", method: "POST", status: 303, rpc: "removeCartItem" }]
];

function pick(rng: () => number, table: readonly (readonly [number, Shape])[]): Shape {
  let draw = rng();
  for (const [weight, shape] of table) {
    if (draw < weight) return shape;
    draw -= weight;
  }
  return table[table.length - 1]![1];
}

export const ALL_SHAPES: readonly Shape[] = [...PAGE_ROUTES.map(([, shape]) => shape), SEARCH, ...CART_ROUTES.map(([, shape]) => shape)];

export function pickShape(rng: () => number): Shape {
  const draw = rng();
  if (draw < 0.7) return pick(rng, PAGE_ROUTES);
  if (draw < 0.9) return SEARCH;
  return pick(rng, CART_ROUTES);
}

export interface Invocation {
  readonly atMs: number;
  readonly traceId: string;
  readonly shape: Shape;
  readonly failure?: "uncaught" | "double-operation";
}

function operationMessage(traceId: string, spanId: string, operation: string) {
  return { channel: OBSERVE_CHANNEL, message: { kind: "operation", traceId, spanId, operation, synthetic: false, rows: null } };
}

export function workerEntry(rng: () => number, invocation: Invocation): SimEntry {
  const { atMs, traceId, shape, failure } = invocation;
  const wallMs = 4 + rng() * 12;
  const operations = [operationMessage(traceId, hex(rng, 16), `request.${shape.route}`)];
  if (failure === "double-operation") operations.push(operationMessage(traceId, hex(rng, 16), `request.${shape.route}`));
  const item: TailItem = {
    event: { request: { url: `https://shop.example${shape.path}`, method: shape.method }, response: { status: failure === "uncaught" ? 500 : shape.status } },
    eventTimestamp: atMs,
    exceptions: failure === "uncaught" ? [{ name: "TypeError", message: "cart total is not a number", stack: "TypeError: cart total is not a number\n    at total (index.js:410:17)\n    at fetch (index.js:902:9)" }] : [],
    diagnosticsChannelEvents: operations,
    scriptName: SERVICE, scriptVersion: { id: VERSION }, executionModel: "stateless",
    outcome: failure === "uncaught" ? "exception" : "ok", cpuTime: 2 + rng() * 3, wallTime: wallMs
  };
  return { nowMs: atMs + Math.ceil(wallMs) + Math.floor(rng() * 100), item };
}

export function objectEntry(rng: () => number, invocation: Invocation, untraced = false): SimEntry {
  const { atMs, traceId, shape } = invocation;
  const rpc = shape.rpc!;
  const wallMs = 2 + rng() * 6;
  const item: TailItem = {
    event: { rpcMethod: rpc },
    eventTimestamp: atMs + 3,
    exceptions: [],
    diagnosticsChannelEvents: untraced ? [] : [operationMessage(traceId, hex(rng, 16), `store.rpc.${rpc}`)],
    scriptName: SERVICE, scriptVersion: { id: VERSION }, executionModel: "durableObject", durableObjectId: OBJECT_ID, entrypoint: "TenantStore",
    outcome: "ok", cpuTime: 1 + rng() * 2, wallTime: wallMs
  };
  return { nowMs: atMs + 3 + Math.ceil(wallMs) + Math.floor(rng() * 100), item };
}

export interface WorkloadOptions {
  readonly seed: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly requestsPerSecond: number;
  readonly keepPerMillion: number;
  readonly fate: (rng: () => number) => Fate;
  readonly failurePerMillion: number;
}

export interface Workload {
  readonly entries: SimEntry[];
  readonly requests: number;
  readonly events: number;
  readonly carts: number;
  readonly failed: number;
}

export function seededWorkload(options: WorkloadOptions): Workload {
  const rng = random(options.seed);
  const entries: SimEntry[] = [];
  const total = Math.round((options.durationMs / 1000) * options.requestsPerSecond);
  let carts = 0;
  let failures = 0;
  for (let n = 0; n < total; n++) {
    const atMs = options.startMs + Math.floor((n / total) * options.durationMs);
    const shape = pickShape(rng);
    const traceId = traceFor(rng, options.keepPerMillion, options.fate(rng));
    const failed = rng() * MILLION < options.failurePerMillion;
    const invocation: Invocation = { atMs, traceId, shape, ...(failed ? { failure: "uncaught" as const } : {}) };
    entries.push(workerEntry(rng, invocation));
    if (failed) failures++;
    if (shape.rpc !== null && !failed) { entries.push(objectEntry(rng, invocation)); carts++; }
  }
  entries.sort((a, b) => a.nowMs - b.nowMs);
  return { entries, requests: total, events: entries.length, carts, failed: failures };
}

export function delta(after: Meter, before: Meter): Meter {
  const byTable: Record<string, number> = {};
  for (const [table, rows] of Object.entries(after.byTable)) byTable[table] = rows - (before.byTable[table] ?? 0);
  const requests: Record<string, number> = {};
  for (const [name, count] of Object.entries(after.requests)) requests[name] = count - (before.requests[name] ?? 0);
  return { rowsWritten: after.rowsWritten - before.rowsWritten, setAlarms: after.setAlarms - before.setAlarms, byTable, requests, nowMs: after.nowMs, pendingTimers: after.pendingTimers };
}
