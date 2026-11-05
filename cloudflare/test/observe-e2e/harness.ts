import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { accessToken } from "../access-token.ts";
import { encodeFrame, type SourceBatch } from "../../src/ingest/encode.ts";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, collectorModules as builtCollectorModules, collectorWorker, miniflareOptions, readBuiltWorker, readTestVars, type Collector as TopologyCollector } from "../../local/topology.ts";

export const ROOT = CLOUDFLARE_ROOT;
const STATS = readBuiltWorker(STATS_OUTPUT);
const OBSERVE = readBuiltWorker(OBSERVE_OUTPUT);
export const VARS = readTestVars();
export const BATCH = JSON.parse(readFileSync(join(ROOT, "../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;
export const ORIGIN = "https://stats.example";
export const HOST_NAME = "host-name-QXZ";
export const SECRET_QUERY = "SECRET_IN_QUERY_7d1f";
const COMPAT = { compatibilityDate: OBSERVE.compatibilityDate, compatibilityFlags: [...OBSERVE.compatibilityFlags] };
const CRASHING_CONSUMER = "export default { tail() { throw new Error('collector down'); }, fetch() { throw new Error('collector down'); } };";

export function collectorModules(scriptName: string) {
  return builtCollectorModules(OBSERVE, scriptName);
}

const MEMORIES_PRODUCER = `
import diagnostics from "node:diagnostics_channel";
import { tracing } from "cloudflare:workers";
const channel = diagnostics.channel("stats.observe");
export default {
  async fetch(request) {
    const span = tracing.getActiveSpan();
    if (span !== undefined) { const context = span.spanContext(); channel.publish({ kind: "invocation", traceId: context.traceId, spanId: context.spanId }); }
    if (new URL(request.url).pathname.startsWith("/api/v1/sync/objects/")) {
      try { throw new TypeError("replacement failed"); }
      catch (error) { channel.publish({ kind: "error", operation: "sync.replace", name: error.name, message: error.message, stack: error.stack ?? null }); }
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({ ok: true });
  }
};`;

export type StatsInit = NonNullable<Parameters<Miniflare["dispatchFetch"]>[1]>;
export type Response = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
export type Collector = "attached" | "crashing" | "absent";

export interface Harness {
  readonly mf: Miniflare;
  readonly persist: string;
  stats(path: string, init?: StatsInit): Promise<Response>;
  observe(path: string): Promise<unknown>;
  observeService(service: string, path: string): Promise<unknown>;
  memories(path: string): Promise<Response>;
  scheduled(): Promise<unknown>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export type Outbound = (request: Request) => Response | Promise<Response>;
const UNAVAILABLE: Outbound = () => new Response("upstream unavailable", { status: 503 });

export async function start(collector: Collector, bindings: Record<string, string> = {}, outbound: Outbound = UNAVAILABLE): Promise<Harness> {
  const persist = mkdtempSync(join(tmpdir(), "observe-e2e-"));
  const { ENVIRONMENT, PROJECTS, WORKER_NAME, ...secrets } = VARS;
  const statsCollector: TopologyCollector = collector === "crashing" ? { kind: "replaced", script: CRASHING_CONSUMER } : { kind: collector };
  const memoriesCollector = collector === "crashing"
    ? { name: "memories-observe", modules: true, script: CRASHING_CONSUMER, ...COMPAT }
    : collectorWorker(OBSERVE, "memories-observe", "usr-memories");
  const memoriesWorker = { name: "usr-memories", modules: true, script: MEMORIES_PRODUCER, ...COMPAT, ...(collector === "absent" ? {} : { tails: ["memories-observe"] }) };
  const mf = new Miniflare(miniflareOptions(STATS, OBSERVE, {
    text: { ENVIRONMENT: ENVIRONMENT!, PROJECTS: PROJECTS!, WORKER_NAME: WORKER_NAME!, ...bindings },
    secrets: { ...secrets, DEPLOYMENTS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", DEPLOYMENTS_API_TOKEN: "SECRET_DEPLOY_TOKEN" },
    analytics: "unbound",
    collector: statsCollector,
    outbound,
    persist,
    alarms: "platform",
    extraWorkers: collector === "absent" ? [memoriesWorker] : [memoriesCollector, memoriesWorker]
  }));
  const stats = await mf.getWorker("stats");
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await mf.dispose();
  };
  return {
    mf,
    persist,
    stats: async (path, init) => mf.dispatchFetch(`${ORIGIN}${path}`, init),
    observe: async path => (await (await mf.getWorker("stats-observe")).fetch(`https://observe/stats${path}`)).json(),
    observeService: async (service, path) => (await (await mf.getWorker("stats-observe")).fetch(`https://observe/${service}${path}`)).json(),
    memories: async path => (await mf.getWorker("usr-memories")).fetch(`https://memories.example${path}`),
    scheduled: async () => stats.scheduled({ cron: "*/5 * * * *", scheduledTime: new Date(Number(VARS["TEST_NOW_MS"])) }),
    stop,
    dispose: async () => { await stop(); rmSync(persist, { recursive: true, force: true }); }
  };
}

export async function accessHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { "cf-access-jwt-assertion": await accessToken(), ...extra };
}

export async function createHost(harness: Harness, name = HOST_NAME): Promise<{ hostId: string; token: string }> {
  const response = await harness.stats("/api/v1/admin/hosts", { method: "POST", headers: await accessHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ name }) });
  assert.equal(response.status, 201);
  return await response.json() as { hostId: string; token: string };
}

export async function ingest(harness: Harness, host: { hostId: string; token: string }, batch: SourceBatch = BATCH): Promise<Response> {
  return harness.stats(`/ingest/v2/batches?token=${SECRET_QUERY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/vnd.stats.ingest.v2", Cookie: "CF_Authorization=SECRET_COOKIE" },
    body: encodeFrame({ ...batch, hostId: host.hostId })
  });
}

export interface Page<T> { readonly items: readonly T[]; readonly next: string | null }
export interface TraceSummary { readonly traceId: string | null; readonly label: string; readonly status: number | null; readonly failed: boolean; readonly objectInvocations: number }
export interface TraceDetail { readonly rootPresent: boolean; readonly invocations: readonly { readonly stage: string; readonly label: string }[]; readonly occurrences: readonly { readonly operation: string | null; readonly name: string }[] }
export interface IssueSummary { readonly fingerprint: string; readonly name: string; readonly operation: string | null; readonly frame: string | null; readonly occurrences: number }
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function workerTraces(harness: Harness): Promise<readonly TraceSummary[]> {
  const page = await harness.observe("/traces?limit=100") as Page<TraceSummary>;
  assert.equal(page.next, null);
  return page.items;
}
